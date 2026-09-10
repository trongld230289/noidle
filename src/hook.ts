/**
 * Hook cho Claude Code, đóng gói thành dist/claude-hook.js. Ba chế độ:
 *   prompt                    UserPromptSubmit: in hướng dẫn để Claude kết thúc bằng dòng 🔊.
 *   speak [--voice] [--rate] [--player]
 *                             Stop: đọc transcript, chọn câu cần đọc, rồi tách tiến trình `play` và thoát ngay.
 *   play <textfile> --kind speak|notify --session <id>
 *                             Tổng hợp giọng bằng Edge TTS, phát bằng ffplay. Xếp hàng theo thứ tự đến;
 *                             câu trả lời mới của cùng một phiên thì cắt câu trả lời cũ của phiên đó.
 *   notify [--voice] ...      Notification / PermissionRequest / PreToolUse(AskUserQuestion): đọc một câu ngắn
 *                             "Workspace X cần approve" hoặc "có câu hỏi", xếp sau lượt đang đọc.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { lastAssistantText, pickSpeech, PROMPT_CONTEXT, splitSentences, announcement, HookInput } from './speech';
import { listenOnce } from './listen';
import { transcribe } from './transcriber';
import { parseApproval, isDangerous } from './decision';

const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';

/** Cấu hình extension ghi ra file cho hook (đường dẫn qua --config). */
interface HookConfig {
  apiKey?: string;
  ffmpegPath?: string;
  micDevice?: string;
  glossary?: string[];
  language?: string;
  voiceApprove?: boolean;
  approveTimeoutSec?: number;
}

function loadConfig(): HookConfig {
  const p = arg('config', '');
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HookConfig;
  } catch (err) {
    log(`không đọc được config ${p}: ${(err as Error).message}`);
    return {};
  }
}
const WORK_DIR = path.join(os.tmpdir(), 'vi-voice-tts');
const QUEUE_DIR = path.join(WORK_DIR, 'queue');
const LOG_FILE = path.join(WORK_DIR, 'hook.log');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function log(msg: string): void {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* bỏ qua */
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    // Timer phòng hờ phải unref, không thì nó giữ tiến trình sống thêm 3s và Claude Code phải chờ theo.
    const timer = setTimeout(() => resolve(data), 3000);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

interface Ticket {
  pid: number;
  player?: number;
  kind: 'speak' | 'notify';
  session: string;
}

/**
 * Hàng đợi phát: mỗi tiến trình play ghi một vé vào QUEUE_DIR, tên vé bắt đầu bằng thời điểm tạo
 * nên sắp theo tên là theo thứ tự đến. Vé của tiến trình đã chết bị dọn. Ai đứng đầu hàng thì phát.
 */
function ticketPath(file: string): string {
  return path.join(QUEUE_DIR, file);
}

function listTickets(): { file: string; t: Ticket }[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: { file: string; t: Ticket }[] = [];
  for (const file of files) {
    try {
      const t = JSON.parse(fs.readFileSync(ticketPath(file), 'utf8')) as Ticket;
      if (t.pid !== process.pid && !alive(t.pid)) {
        fs.unlinkSync(ticketPath(file));
        continue;
      }
      out.push({ file, t });
    } catch {
      /* vé hỏng hoặc vừa bị xoá */
    }
  }
  return out;
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pid?: number): void {
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid);
  } catch {
    /* đã thoát */
  }
}

/** Ghi vé của mình. Câu trả lời mới của cùng một phiên thì cắt câu trả lời cũ của phiên đó. */
function takeTicket(kind: Ticket['kind'], session: string): string {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  if (kind === 'speak' && session) {
    for (const { file, t } of listTickets()) {
      if (t.kind === 'speak' && t.session === session) {
        kill(t.player);
        kill(t.pid);
        try {
          fs.unlinkSync(ticketPath(file));
        } catch {
          /* bỏ qua */
        }
      }
    }
  }
  const file = `${String(Date.now()).padStart(15, '0')}-${process.pid}.json`;
  const t: Ticket = { pid: process.pid, kind, session };
  fs.writeFileSync(ticketPath(file), JSON.stringify(t));
  process.on('exit', () => {
    try {
      fs.unlinkSync(ticketPath(file));
    } catch {
      /* đã xoá */
    }
  });
  return file;
}

function updateTicket(file: string, patch: Partial<Ticket>): void {
  try {
    const t = JSON.parse(fs.readFileSync(ticketPath(file), 'utf8')) as Ticket;
    fs.writeFileSync(ticketPath(file), JSON.stringify({ ...t, ...patch }));
  } catch {
    /* vé đã bị cắt */
  }
}

/** Chờ đến lượt mình (vé đứng đầu hàng). Quá maxMs thì phát luôn để không kẹt mãi. */
async function waitTurn(file: string, maxMs = 5 * 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const first = listTickets()[0];
    if (!first || first.file === file) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function modePrompt(): Promise<void> {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_CONTEXT } }),
  );
}

async function modeSpeak(): Promise<void> {
  const input = JSON.parse((await readStdin()) || '{}') as { transcript_path?: string; stop_hook_active?: boolean; session_id?: string };
  if (input.stop_hook_active || !input.transcript_path) return;
  let transcript: string;
  try {
    transcript = fs.readFileSync(input.transcript_path, 'utf8');
  } catch (err) {
    log(`không đọc được transcript: ${(err as Error).message}`);
    return;
  }
  const text = pickSpeech(lastAssistantText(transcript));
  if (!text) return;
  spawnPlay(text, 'speak', input.session_id ?? '');
}

/** Tách tiến trình phát rồi thoát ngay để Claude Code không phải chờ. */
function spawnPlay(text: string, kind: Ticket['kind'], session: string): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `say-${Date.now()}-${process.pid}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  const args = [__filename, 'play', file, '--voice', arg('voice', DEFAULT_VOICE), '--rate', arg('rate', '+0%'), '--player', arg('player', 'ffplay')];
  args.push('--kind', kind, '--session', session || '-');
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  log(`${kind} → play pid ${child.pid}: ${JSON.stringify(text)}`);
}

async function modeNotify(): Promise<void> {
  const input = JSON.parse((await readStdin()) || '{}') as HookInput & { session_id?: string };
  const text = announcement(input);
  log(`notify ${input.hook_event_name ?? '?'} ${input.notification_type ?? input.tool_name ?? ''}: ${JSON.stringify(text)}`);
  if (!text) return;
  const cfg = loadConfig();
  if (input.hook_event_name === 'PermissionRequest' && cfg.voiceApprove && cfg.apiKey) {
    if (isDangerous(input.tool_name, input.tool_input)) {
      spawnPlay(`${text} Lệnh này thuộc loại nguy hiểm, bạn bấm tay nhé.`, 'notify', input.session_id ?? '');
      return;
    }
    await voiceApprove(text, input, cfg);
    return;
  }
  spawnPlay(text, 'notify', input.session_id ?? '');
}

/**
 * Approve bằng giọng: đọc thông báo (chờ đọc xong), mở mic nghe một câu, hỏi Whisper,
 * rồi trả quyết định cho Claude Code. Không rõ hoặc im lặng thì không trả gì, hộp thoại hiện như thường.
 */
async function voiceApprove(text: string, input: HookInput & { session_id?: string }, cfg: HookConfig): Promise<void> {
  const session = input.session_id ?? '';
  const t0 = Date.now();
  await playNow(`${text} Nói approve hoặc từ chối.`, 'notify', session);
  const maxMs = Math.max(3, cfg.approveTimeoutSec ?? 15) * 1000;
  const wav = await listenOnce({ ffmpegPath: cfg.ffmpegPath || 'ffmpeg', device: cfg.micDevice || undefined, maxMs, log });
  if (!wav) {
    log(`approve: không nghe thấy gì sau ${Date.now() - t0}ms`);
    return;
  }
  let heard = '';
  try {
    heard = await transcribe(wav, { apiKey: cfg.apiKey!, glossary: cfg.glossary, language: cfg.language });
  } catch (err) {
    log(`approve: whisper lỗi ${(err as Error).message}`);
    return;
  }
  const decision = parseApproval(heard);
  log(`approve: nghe ${JSON.stringify(heard)} → ${decision ?? 'không rõ'} (${Date.now() - t0}ms)`);
  if (!decision) {
    spawnPlay('Mình không rõ, bạn bấm tay nhé.', 'notify', session);
    return;
  }
  spawnPlay(decision === 'allow' ? 'Đã approve.' : 'Đã từ chối.', 'notify', session);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        permissionDecision: decision,
        permissionDecisionReason: `Người dùng ${decision === 'allow' ? 'approve' : 'từ chối'} bằng giọng nói: "${heard}"`,
      },
    }),
  );
}

/** Debug: `listen --config <cfg> [--seconds N]` mở mic, in ra chữ nghe được và quyết định approve tương ứng. */
async function modeListen(): Promise<void> {
  const cfg = loadConfig();
  const maxMs = Number(arg('seconds', '8')) * 1000;
  process.stdout.write(`Đang nghe ${maxMs / 1000}s... nói "approve" hoặc "từ chối"\n`);
  const t0 = Date.now();
  const wav = await listenOnce({ ffmpegPath: cfg.ffmpegPath || 'ffmpeg', device: cfg.micDevice || undefined, maxMs, log: (m) => process.stdout.write(m + '\n') });
  if (!wav) {
    process.stdout.write(`Không nghe thấy gì (${Date.now() - t0}ms)\n`);
    return;
  }
  process.stdout.write(`Thu được ${((wav.byteLength - 44) / 32000).toFixed(1)}s tiếng nói sau ${Date.now() - t0}ms\n`);
  if (!cfg.apiKey) {
    process.stdout.write('Không có apiKey trong config nên không gửi Whisper.\n');
    return;
  }
  const heard = await transcribe(wav, { apiKey: cfg.apiKey, glossary: cfg.glossary, language: cfg.language });
  process.stdout.write(`Nghe: ${JSON.stringify(heard)} → ${parseApproval(heard) ?? 'không rõ'} (${Date.now() - t0}ms)\n`);
}

/** Phát ngay trong tiến trình này và chờ phát xong (vẫn xếp hàng chung). */
async function playNow(text: string, kind: Ticket['kind'], session: string): Promise<void> {
  const ticket = takeTicket(kind, session);
  await waitTurn(ticket);
  await playText(text, ticket);
  try {
    fs.unlinkSync(ticketPath(ticket));
  } catch {
    /* bỏ qua */
  }
}

async function synthOnce(voice: string, rate: string, text: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text, { rate });
  const chunks: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (c: Buffer) => chunks.push(c));
      audioStream.on('error', reject);
      audioStream.on('end', resolve);
    });
  } finally {
    tts.close();
  }
  return Buffer.concat(chunks);
}

/** Edge thỉnh thoảng đóng kết nối không trả audio (bị chặn tạm khi gọi dồn dập); thử lại với giãn cách tăng dần. */
async function synth(voice: string, rate: string, text: string): Promise<Buffer> {
  const waits = [1500, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await synthOnce(voice, rate, text);
    } catch (err) {
      if (attempt >= waits.length) throw err;
      log(`tts lỗi, thử lại sau ${waits[attempt]}ms: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

async function modePlay(): Promise<void> {
  const file = process.argv[3];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const kind = (arg('kind', 'speak') === 'notify' ? 'notify' : 'speak') as Ticket['kind'];
  const session = arg('session', '-');
  const ticket = takeTicket(kind, session === '-' ? '' : session);
  await waitTurn(ticket);
  await playText(text, ticket);
  try {
    fs.unlinkSync(file);
  } catch {
    /* bỏ qua */
  }
}

/** Tổng hợp từng khối và đưa vào ffplay; trả về khi phát xong hoặc bị cắt. */
async function playText(text: string, ticket: string): Promise<void> {
  const t0 = Date.now();
  const voice = arg('voice', DEFAULT_VOICE);
  const rate = arg('rate', '+0%');

  const player = spawn(
    arg('player', 'ffplay'),
    ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 'mp3', '-i', 'pipe:0'],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
  );
  updateTicket(ticket, { player: player.pid });
  let stopped = false;
  player.stdin.on('error', () => undefined); // ffplay bị tắt giữa chừng thì bỏ qua EPIPE
  player.on('error', (e) => {
    log(`không chạy được player: ${e.message}`);
    stopped = true;
  });
  player.on('exit', () => (stopped = true));

  // Đường ống: tổng hợp từng câu tuần tự (Edge chặn nếu mở nhiều kết nối cùng lúc);
  // câu i+1 được tổng hợp trong lúc ffplay còn đang phát câu i nên không bị ngắt quãng.
  const sentences = splitSentences(text);
  for (let i = 0; i < sentences.length && !stopped; i++) {
    try {
      const audio = await synth(voice, rate, sentences[i]);
      if (i === 0) log(`câu đầu sẵn sàng sau ${Date.now() - t0}ms (${sentences.length} câu)`);
      if (stopped) break;
      player.stdin.write(audio);
    } catch (err) {
      log(`bỏ câu ${i + 1}: ${(err as Error).message}`);
    }
  }
  player.stdin.end();
  await new Promise<void>((r) => (stopped ? r() : player.on('exit', () => r())));
  log(`phát xong sau ${Date.now() - t0}ms`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'prompt') return modePrompt();
  if (mode === 'speak') return modeSpeak();
  if (mode === 'play') return modePlay();
  if (mode === 'notify') return modeNotify();
  if (mode === 'listen') return modeListen();
  process.stderr.write('usage: claude-hook.js prompt | speak | notify | listen | play <file>\n');
  process.exitCode = 2;
}

main().catch((err) => {
  log(`lỗi ${process.argv[2]}: ${(err as Error).stack ?? err}`);
  // Hook không được làm Claude Code lỗi theo.
  process.exitCode = 0;
});
