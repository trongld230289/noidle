/**
 * Hook cho Claude Code, đóng gói thành dist/claude-hook.js. Ba chế độ:
 *   prompt                    UserPromptSubmit: in hướng dẫn để Claude kết thúc bằng dòng 🔊.
 *   speak [--voice] [--rate] [--player]
 *                             Stop: đọc transcript, chọn câu cần đọc, rồi tách tiến trình `play` và thoát ngay.
 *   play <textfile> [...]     Tổng hợp giọng bằng Edge TTS, phát bằng ffplay. Tắt lượt đọc trước nếu còn.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { lastAssistantText, pickSpeech, PROMPT_CONTEXT, splitSentences } from './speech';

const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';
const WORK_DIR = path.join(os.tmpdir(), 'vi-voice-tts');
const PID_FILE = path.join(WORK_DIR, 'playing.json');
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
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function killPrevious(): void {
  try {
    const prev = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as { node?: number; player?: number };
    for (const pid of [prev.player, prev.node]) {
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid);
        } catch {
          /* đã thoát */
        }
      }
    }
  } catch {
    /* chưa có */
  }
}

async function modePrompt(): Promise<void> {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_CONTEXT } }),
  );
}

async function modeSpeak(): Promise<void> {
  const input = JSON.parse((await readStdin()) || '{}') as { transcript_path?: string; stop_hook_active?: boolean };
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
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `say-${Date.now()}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  const child = spawn(
    process.execPath,
    [__filename, 'play', file, '--voice', arg('voice', DEFAULT_VOICE), '--rate', arg('rate', '+0%'), '--player', arg('player', 'ffplay')],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  log(`speak → play pid ${child.pid}: ${JSON.stringify(text)}`);
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
  killPrevious();
  fs.writeFileSync(PID_FILE, JSON.stringify({ node: process.pid }));
  const t0 = Date.now();
  const voice = arg('voice', DEFAULT_VOICE);
  const rate = arg('rate', '+0%');

  const player = spawn(
    arg('player', 'ffplay'),
    ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 'mp3', '-i', 'pipe:0'],
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
  );
  fs.writeFileSync(PID_FILE, JSON.stringify({ node: process.pid, player: player.pid }));
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
  try {
    fs.unlinkSync(file);
  } catch {
    /* bỏ qua */
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'prompt') return modePrompt();
  if (mode === 'speak') return modeSpeak();
  if (mode === 'play') return modePlay();
  process.stderr.write('usage: claude-hook.js prompt | speak | play <file>\n');
  process.exitCode = 2;
}

main().catch((err) => {
  log(`lỗi ${process.argv[2]}: ${(err as Error).stack ?? err}`);
  // Hook không được làm Claude Code lỗi theo.
  process.exitCode = 0;
});
