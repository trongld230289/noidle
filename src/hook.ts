/**
 * Hook cho Claude Code, Copilot Chat và Copilot CLI, đóng gói thành dist/claude-hook.js.
 * Copilot gửi stdin cùng các trường (session_id, transcript_path, stop_hook_active, cwd = thư mục workspace),
 * chỉ khác định dạng transcript (speech.ts hiểu cả hai). Các chế độ:
 *   prompt [--config]         UserPromptSubmit: in hướng dẫn để Claude kết thúc bằng dòng 🔊 (trừ khi config voiceResponse false).
 *   prompt                    ...rồi báo extension (tín hiệu submitted) là người dùng đã gửi, để tắt mic hands-free.
 *   speak [--voice] [--rate] [--player]
 *                             Stop: đọc transcript, chọn câu cần đọc, rồi tách tiến trình `play` và thoát ngay.
 *                             Hands-free: play xong thì báo extension mở mic (tín hiệu listen), hook không tự nghe.
 *                             Config voiceResponse false thì speak và notify chỉ báo cửa sổ, không đọc; đổi cờ có hiệu lực ngay.
 *   play <textfile> --kind speak|notify --session <id> [--listen <cwd> --claude-pid <pid>]
 *                             Tổng hợp giọng bằng Edge TTS (hoặc ElevenLabs theo file --config), phát bằng ffplay. Xếp hàng theo thứ tự đến;
 *                             câu trả lời mới của cùng một phiên thì cắt câu trả lời cũ của phiên đó.
 *                             Có --listen thì phát xong gửi tín hiệu listen cho cửa sổ VS Code của cwd đó, kèm chuỗi
 *                             pid tổ tiên của Claude (--claude-pid) để extension chọn đúng terminal đang chạy Claude.
 *   skip                      Bỏ qua bản đang đọc (tắt player của vé đầu hàng); extension gọi từ lệnh/phím tắt.
 *   notify [--voice] ...      Notification / PermissionRequest / PreToolUse(AskUserQuestion): đọc một câu ngắn
 *                             "Workspace X cần approve" hoặc "cần bạn xác nhận câu trả lời", xếp sau lượt đang đọc.
 *                             Có --config với handsFree thì nhờ extension mở mic (tín hiệu ask),
 *                             nhận chữ nghe được và trả quyết định. Hook không tự mở mic.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { lastAssistantText, pickSpeech, hasSpeakSection, pendingBackgroundTasks, queuedPrompts, briefTool, promptStopRecap, splitSentences, announcement, doneAnnouncement, workspaceName, spoken, HookInput } from './speech';
import { recapInstruction, type RecapPrompts } from './recapPrompt';
import { langOf, isAuto, detectLang, effectiveVoice, usesVietPronunciation, DEFAULT_VOICE, type Lang } from './lang';
import { parseApproval, isDangerous, voiceApprovable, parseChoice, isChoiceCancellation, isAmbiguousChoice, permissionRequestOutput } from './decision';
import { signalWindow, signalAgentWindow, askWindow, readRegistry, micHolder, MIC_LOCK_MAX_AGE_MS, type Signal, type SignalSource, type AttentionReason } from './signal';
import { ancestorsOf, parentMap } from './proctree';
import { resolvePlayer } from './findTool';
import { flashHostWindow } from './attention';
import { hedged } from './hedge';
import { pronounce } from './pronounce';
import { prefetchInOrder } from './prefetch';
import { synthElevenLabs, rateToSpeed, fetchUsage, writeUsage, readUsage, formatUsage, isQuotaError, elevenExhausted } from './elevenlabs';
import { normalizeCopilotInput, copilotPermissionState, type AgentHookInput } from './copilot';
import { chatWouldAutoApprove, type ChatAutoApprove } from './chatAutoApprove';

let inputSource: SignalSource | undefined;
let permissionPlayback: { transcript: string; requestId: string } | undefined;
let permissionReadWarning = false;

function trackPermissionNotification(input: AgentHookInput): void {
  if (sourceArg() !== 'copilot-cli' || input.hook_event_name !== 'Notification' ||
      input.notification_type !== 'permission_prompt') return;
  if ((typeof input.timestamp !== 'number' && typeof input.timestamp !== 'string') || typeof input.message !== 'string') {
    log('notify: permission lifecycle unavailable (missing notification identity), keeping legacy alert');
    return;
  }
  const session = input.session_id ?? '';
  const transcript = input.transcript_path || (/^[\w-]+$/.test(session)
    ? path.join(os.homedir(), '.copilot', 'session-state', session, 'events.jsonl') : '');
  try {
    const state = copilotPermissionState(fs.readFileSync(transcript, 'utf8'), {
      timestamp: input.timestamp, message: input.message,
    });
    if (state) permissionPlayback = { transcript, requestId: state.requestId };
    else log('notify: permission lifecycle could not be correlated, keeping legacy alert');
  } catch (err) {
    log(`notify: cannot read permission lifecycle, keeping legacy alert: ${(err as Error).message}`);
  }
}

function permissionCompleted(): boolean {
  if (!permissionPlayback) return false;
  try {
    const state = copilotPermissionState(fs.readFileSync(permissionPlayback.transcript, 'utf8'), permissionPlayback.requestId);
    if (state?.completed) {
      log(`notify: permission ${permissionPlayback.requestId} already completed, dropping stale alert`);
      return true;
    }
    if (!state && !permissionReadWarning) {
      log('notify: tracked permission missing from transcript, keeping legacy alert');
      permissionReadWarning = true;
    }
  } catch (err) {
    if (!permissionReadWarning) {
      log(`notify: cannot recheck permission, keeping legacy alert: ${(err as Error).message}`);
      permissionReadWarning = true;
    }
  }
  return false;
}

async function readHookInput(event: string): Promise<AgentHookInput> {
  const value: unknown = JSON.parse((await readStdin()) || '{}');
  if (arg('source', 'claude') !== 'copilot') return value as AgentHookInput;
  const normalized = normalizeCopilotInput(value, event);
  inputSource = normalized.source;
  return normalized.input;
}

/** Cấu hình extension ghi ra file cho hook (đường dẫn qua --config). */
interface HookConfig {
  voice?: string;
  /**
   * Setting noIdle.voiceResponse. false: không đọc, không nói câu báo, không chèn hướng dẫn 🔊; mic theo handsFree, vẫn nháy
   * và đổi màu cửa sổ. Hook luôn được cài khi còn tính năng nào bật, nên đổi cờ này có hiệu lực ngay ở lượt sau.
   */
  voiceResponse?: boolean;
  /** false: không đọc câu báo "cần approve" / "cần bạn trả lời" (vẫn nháy). Chỉ có nghĩa khi voiceResponse bật. */
  voiceNotify?: boolean;
  /** false: hook không tự nháy cửa sổ chứa agent (terminal rời); extension vẫn nhận tín hiệu để đổi màu. */
  attentionFlash?: boolean;
  approveTimeoutSec?: number;
  /** Rảnh tay: duyệt lệnh an toàn và chọn đáp án bằng giọng, và extension tự mở mic sau khi đọc xong câu trả lời. */
  handsFree?: boolean;
  /** Bảng của người dùng: thuật ngữ → cách đọc, ghi đè bảng mặc định trong pronounce.ts. */
  pronunciations?: Record<string, string>;
  /**
   * recap (mặc định): dặn Claude viết phần 🔊 và đọc phần đó. announce: không dặn gì (0 token), Stop chỉ đọc câu cứng tiếng Anh
   * "Workspace X is done." hoặc "is asking you."; approve và chọn đáp án vẫn như cũ vì vốn là câu cứng.
   */
  voiceStyle?: 'recap' | 'announce';
  /** Mở đầu phần đọc bằng "Workspace X:" — auto: chỉ khi có hơn một cửa sổ VS Code đang mở. */
  voiceSayWorkspace?: 'auto' | 'always' | 'never';
  /**
   * Setting noIdle.language: 'en' thì hướng dẫn, câu báo và lý do trả về Claude đều tiếng Anh, bỏ bảng phiên âm mặc định.
   * 'auto' thì đoán theo prompt vừa gửi và nhớ theo phiên (dấu phiên trong SESSION_DIR).
   */
  language?: string;
  /** Giọng đọc: mặc định Edge; elevenlabs thì hook gọi ElevenLabs bằng key trong file này, lỗi thì lùi về Edge. */
  tts?: TtsConfig;
  /**
   * Thân hướng dẫn recap (setting noIdle.recapPrompt) ở hai thứ tiếng: bản người dùng viết và bản extension dịch.
   * Thiếu thứ tiếng nào thì hook dùng bản kia; thiếu cả hai thì bản mặc định. Hợp đồng 🔊 và câu ngôn ngữ hook tự nối.
   */
  recapPrompt?: RecapPrompts;
  /**
   * Setting auto-approve của VS Code (extension gộp và ghi). Hands Free tắt: Chat chỉ được đọc "cần approve" cho
   * lệnh terminal VS Code không tự duyệt, kèm 'ask' để hộp thoại chắc chắn hiện. Thiếu thì dùng danh sách an toàn.
   */
  chatAutoApprove?: ChatAutoApprove;
}

interface TtsConfig {
  provider?: 'edge' | 'elevenlabs';
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModel?: string;
}

/** Ngôn ngữ cho một sự kiện không có prompt (speak, notify): setting cố định, hoặc ngôn ngữ đã nhớ của phiên khi auto. */
function sessionLang(cfg: HookConfig, session: string | undefined): Lang {
  if (!isAuto(cfg.language)) return langOf(cfg.language);
  return (session && readMark(session).lang) || 'vi';
}

/**
 * Chuỗi pid từ Claude Code (cha của hook) đi lên: qua wrapper claude.cmd tới shell của terminal VS Code.
 * Extension so với processId của từng terminal để gõ vào đúng terminal đang chạy Claude. Lỗi thì rỗng, extension fallback.
 */
async function claudeAncestors(claudePid: number, session: string): Promise<number[]> {
  if (!claudePid) return [];
  // Tra cây tiến trình (PowerShell CIM) mất hơn một giây; pid Claude không đổi trong phiên nên lưu lại theo phiên.
  const mark = session ? readMark(session) : undefined;
  if (mark?.proc?.pid === claudePid && mark.proc.chain.length) {
    log(`proctree: dùng lại chuỗi đã lưu của phiên (${mark.proc.chain.join(' ← ')})`);
    return mark.proc.chain;
  }
  const t0 = Date.now();
  const chain = ancestorsOf(claudePid, await parentMap());
  log(`proctree: ${chain.join(' ← ') || 'rỗng'} (${Date.now() - t0}ms)`);
  if (session && chain.length > 1) writeMark(session, { ...readMark(session), proc: { pid: claudePid, chain } });
  return chain;
}

/** Nhờ extension mở mic nghe một câu; trả '' nếu không có cửa sổ VS Code, im lặng hoặc lỗi. */
async function askHeard(cwd: string, session: string, timeoutSec: number, label: string): Promise<string> {
  const t0 = Date.now();
  const reason = label === 'approve' ? 'approve' : 'answer';
  const heard = (await requestMicrophone({ event: 'ask', session, cwd, timeoutSec, reason })) ?? '';
  log(`${label}: nghe ${JSON.stringify(heard)} (${Date.now() - t0}ms)`);
  return heard.trim();
}

async function requestMicrophone(signal: Signal & { event: 'listen' | 'ask' }): Promise<string | undefined> {
  const promptCount = readMark(signal.session).count;
  const ticket = takeTicket('notify', signal.session);
  try {
    const ancestors = sourceArg() === 'copilot' ? [] : await claudeAncestors(process.ppid, signal.session);
    await waitTurn(ticket);
    if (listTickets()[0]?.file !== ticket || !loadConfig().handsFree || readMark(signal.session).count !== promptCount) return;
    const request = { ...signal, ancestors, source: sourceArg() };
    if (signal.event === 'ask') return await askWindow(request, undefined, log);
    await signalWindow(request, undefined, log);
  } finally {
    fs.rmSync(ticketPath(ticket), { force: true });
  }
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
/** Tắt đọc: thiếu cờ (config cũ) coi như bật. */
function voiceOff(cfg: HookConfig): boolean {
  return cfg.voiceResponse === false;
}
const WORK_DIR = path.join(os.tmpdir(), 'noidle-tts');
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

const SESSION_DIR = path.join(WORK_DIR, 'sessions');
const SESSION_MARK_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Dấu phiên: số prompt đã qua và ngôn ngữ đang dùng của phiên đó. Bản cũ chỉ ghi số. */
interface SessionMark {
  count: number;
  lang?: Lang;
  /** voiceStyle đã áp cho prompt trước của phiên; thiếu (dấu cũ) coi như recap. Đổi giữa phiên thì chèn câu chuyển. */
  style?: 'recap' | 'announce';
  /** Chuỗi pid tổ tiên của Claude Code (pid không đổi trong một phiên), để khỏi tra cây tiến trình mỗi lượt. */
  proc?: { pid: number; chain: number[] };
}

function markPath(session: string): string {
  return path.join(SESSION_DIR, session.replace(/[^\w.-]/g, '_'));
}

function readMark(session: string): SessionMark {
  let raw: string;
  try {
    raw = fs.readFileSync(markPath(session), 'utf8');
  } catch {
    pruneSessionMarks();
    return { count: 0 };
  }
  const n = Number(raw);
  if (!Number.isNaN(n)) return { count: n };
  try {
    const o = JSON.parse(raw) as { count?: unknown; lang?: unknown; style?: unknown; proc?: { pid?: unknown; chain?: unknown } };
    const mark: SessionMark = { count: Number(o.count) || 0, lang: o.lang === 'en' ? 'en' : o.lang === 'vi' ? 'vi' : undefined };
    if (o.style === 'announce' || o.style === 'recap') mark.style = o.style;
    if (o.proc && typeof o.proc.pid === 'number' && Array.isArray(o.proc.chain)) {
      mark.proc = { pid: o.proc.pid, chain: o.proc.chain.filter((n): n is number => typeof n === 'number') };
    }
    return mark;
  } catch {
    return { count: 0 };
  }
}

function writeMark(session: string, mark: SessionMark): void {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(markPath(session), JSON.stringify(mark));
  } catch (err) {
    log(`không ghi được dấu phiên: ${(err as Error).message}`);
  }
}

/** Câu trả lời ngay trước có phần 🔊 không (Claude tự viết dù không được dặn: thói quen từ memory hay lượt trước). */
function lastAnswerHadSpeak(transcriptPath: string | undefined): boolean {
  if (!transcriptPath) return false;
  try {
    return hasSpeakSection(lastAssistantText(fs.readFileSync(transcriptPath, 'utf8')));
  } catch {
    return false;
  }
}

/**
 * Hướng dẫn cho prompt này: recap thì gửi nguyên hướng dẫn (ngắn, người dùng tự sửa qua noIdle.recapPrompt) ở mọi lượt,
 * không còn bản đầy đủ / nhắc ngắn. Dấu phiên (file theo session_id) chỉ để nhớ ngôn ngữ và voiceStyle của lượt trước.
 * Ngôn ngữ: setting cố định, hoặc khi auto thì đoán từ prompt, không đoán được thì giữ của phiên.
 */
function promptContextFor(session: string | undefined, cfg: HookConfig, promptText: string, lastHadSpeak = false): string {
  const auto = isAuto(cfg.language);
  const style = cfg.voiceStyle === 'announce' ? 'announce' : 'recap';
  if (!session) return style === 'announce' ? '' : recapInstruction(cfg.recapPrompt, auto ? (detectLang(promptText) ?? 'vi') : langOf(cfg.language));
  const mark = readMark(session);
  const lang = auto ? (detectLang(promptText) ?? mark.lang ?? 'vi') : langOf(cfg.language);
  // Dấu cũ (trước khi có voiceStyle) không ghi style: phiên đó đã nhận hướng dẫn recap.
  const prevStyle = mark.count === 0 ? undefined : mark.style ?? 'recap';
  writeMark(session, { count: mark.count + 1, lang, style, proc: mark.proc });
  if (auto) log(`prompt: ngôn ngữ ${lang} (${detectLang(promptText) ? 'đoán từ prompt' : 'giữ của phiên'}) ${JSON.stringify(promptText.slice(0, 60))}`);
  if (style === 'announce') {
    // Hướng dẫn 🔊 còn trong lịch sử phiên (hay Claude tự viết theo memory/lượt trước) thì Claude vẫn viết phần đó: bảo thôi.
    if (prevStyle === 'recap' || lastHadSpeak) {
      log(`prompt: ${prevStyle === 'recap' ? 'voiceStyle recap → announce' : 'câu trước có phần 🔊'}, bảo Claude thôi viết phần 🔊`);
      return promptStopRecap(lang);
    }
    log('prompt: voiceStyle announce, không chèn hướng dẫn');
    return '';
  }
  if (mark.lang !== undefined && mark.lang !== lang) log(`prompt: đổi ngôn ngữ ${mark.lang} → ${lang}`);
  if (prevStyle === 'announce') log('prompt: voiceStyle announce → recap, chèn lại hướng dẫn recap');
  return recapInstruction(cfg.recapPrompt, lang);
}

/** Xoá dấu của các phiên cũ hơn một tuần; chỉ chạy khi gặp phiên mới nên rất thưa. */
function pruneSessionMarks(): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(SESSION_DIR)) {
      const p = path.join(SESSION_DIR, f);
      if (now - fs.statSync(p).mtimeMs > SESSION_MARK_MAX_AGE_MS) fs.unlinkSync(p);
    }
  } catch {
    /* chưa có thư mục hoặc lỗi lặt vặt, bỏ qua */
  }
}

async function modeStart(): Promise<void> {
  const input = await readHookInput('SessionStart');
  if (sourceArg() !== 'copilot-cli' || input.agent_id) return;
  const cfg = loadConfig();
  if (voiceOff(cfg) || cfg.voiceStyle === 'announce') return;
  const lang = isAuto(cfg.language)
    ? detectLang(input.initial_prompt ?? '') ?? sessionLang(cfg, input.session_id)
    : langOf(cfg.language);
  process.stdout.write(JSON.stringify({ additionalContext: recapInstruction(cfg.recapPrompt, lang) }));
}

async function modePrompt(): Promise<void> {
  let input: AgentHookInput = {};
  if (arg('source', 'claude') === 'copilot') {
    input = await readHookInput('UserPromptSubmit');
  } else {
    try {
      input = await readHookInput('UserPromptSubmit');
    } catch (err) {
      log(`prompt: invalid input: ${(err as Error).message}`);
    }
  }
  // Prompt do subagent gửi (Agent tool) cũng qua hook này với cùng session_id: không phải người dùng nói,
  // nên không đếm, không đổi ngôn ngữ phiên, không chèn hướng dẫn 🔊 và không tắt mic đang mở.
  if (input.agent_id) {
    log(`prompt: của subagent ${input.agent_type ?? input.agent_id}, bỏ qua`);
    return;
  }
  const promptText = typeof input.prompt === 'string' ? input.prompt : '';
  if (promptText.trimStart().startsWith('<task-notification>')) {
    // Không phải người dùng nói: không đếm, không đổi ngôn ngữ, không tắt mic. Nhưng Claude sắp chạy tiếp,
    // cửa sổ không còn "done": bảo extension bỏ màu và chữ "Claude is done".
    log(`prompt: background task notification, session ${input.session_id ?? '-'}, chỉ báo resumed`);
    await signalWindow({ event: 'resumed', session: input.session_id ?? '', cwd: input.cwd || process.cwd(), source: sourceArg() }, undefined, log);
    return;
  }
  // Tắt đọc thì không dặn Claude viết phần 🔊, nhưng vẫn báo submitted để tắt mic nếu đang mở.
  const cfg = loadConfig();
  if (voiceOff(cfg)) {
    if (input.session_id) {
      const mark = readMark(input.session_id);
      const lang = isAuto(cfg.language) ? detectLang(promptText) ?? mark.lang ?? 'vi' : langOf(cfg.language);
      writeMark(input.session_id, { ...mark, count: mark.count + 1, lang });
    }
    log('prompt: voiceResponse tắt, không chèn hướng dẫn');
  }
  else {
    // announce thường trả rỗng (vẫn cập nhật dấu phiên để speak/notify chọn đúng ngôn ngữ), chỉ có chữ khi vừa đổi kiểu.
    const additionalContext = promptContextFor(input.session_id, cfg, promptText, lastAnswerHadSpeak(input.transcript_path));
    if (additionalContext) {
      const output = sourceArg() === 'copilot-cli'
        ? { modifiedPrompt: `${promptText}\n\n${additionalContext}` }
        : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } };
      process.stdout.write(JSON.stringify(output));
    }
  }
  // Người dùng vừa gửi prompt: bảo extension tắt mic hands-free nếu đang mở. Không có cửa sổ thì thôi.
  const cwd = input.cwd || process.cwd();
  await signalWindow({ event: 'submitted', session: input.session_id ?? '', cwd, source: sourceArg() }, undefined, log);
}

async function modeSpeak(): Promise<void> {
  const input = await readHookInput('Stop');
  // Ghi nguồn gọi: Claude Code (~/.claude/settings.json) và Copilot (~/.copilot/hooks/noidle.json) đều gọi hook này.
  log(`speak: session ${input.session_id ?? '-'} cwd ${input.cwd ?? '-'} transcript ${input.transcript_path ?? '-'}`);
  if (!input.transcript_path) return;
  // Một hook khác vừa chặn Stop và Claude làm tiếp: không đọc lại để khỏi lặp.
  if (input.stop_hook_active) return;
  const cfg = loadConfig();
  // Ghi kiểu đọc và file cấu hình đang dùng: người dùng bật announce mà vẫn nghe recap thì log này chỉ ra hook đọc file nào.
  log(`speak: voiceStyle ${cfg.voiceStyle ?? 'recap (mặc định, không có trong config)'}, config ${arg('config', '') || '(không có --config)'}`);
  let transcript: string;
  try {
    transcript = fs.readFileSync(input.transcript_path, 'utf8');
  } catch (err) {
    log(`không đọc được transcript: ${(err as Error).message}`);
    return;
  }
  // Claude kết thúc lượt mà còn agent hay lệnh chạy nền: nó đang chờ, chưa xong. Claude Code sẽ gọi nó lại
  // khi việc nền xong. Không báo "done", không nháy, không mở mic; chỉ đọc nếu Claude chủ ý viết phần 🔊
  // (báo tiến độ cho người đang nghe). Hết việc nền rồi mới báo như thường, kể cả ở lượt do notification mở.
  // Người dùng gõ tiếp lúc Claude đang làm: câu đó nằm trong hàng đợi và Claude làm ngay, cũng chưa xong.
  const queued = queuedPrompts(transcript);
  const pending = [...pendingBackgroundTasks(transcript), ...(queued ? [`${queued} prompt đang xếp hàng`] : [])];
  const waiting = pending.length > 0;
  // Làm nổi cửa sổ (nháy taskbar, đổi màu status bar) kể cả khi mute: không có tiếng, chỉ để tìm đúng cửa sổ.
  const attentionSent = waiting ? Promise.resolve(false) : attention('done', input.session_id ?? '', input.cwd || process.cwd(), cfg);
  if (voiceOff(cfg)) {
    log('speak: voiceResponse tắt, không đọc');
    if (cfg.handsFree && !waiting) {
      await requestMicrophone({ event: 'listen', session: input.session_id ?? '', cwd: input.cwd || process.cwd() });
    }
    await attentionSent;
    return;
  }
  const answer = lastAssistantText(transcript);
  if (waiting && !hasSpeakSection(answer)) {
    log(`speak: còn ${pending.length} việc nền đang chạy (${pending.join(', ')}), chưa xong nên không báo`);
    return;
  }
  if (waiting) log(`speak: còn ${pending.length} việc nền đang chạy, chỉ đọc phần 🔊, không mở mic`);
  const session = input.session_id ?? '';
  const cwd = input.cwd || process.cwd();
  // announce luôn đọc tiếng Anh ("Workspace X is done."), bất kể ngôn ngữ của phiên.
  const lang = cfg.voiceStyle === 'announce' ? 'en' : sessionLang(cfg, session);
  let text: string;
  if (cfg.voiceStyle === 'announce') {
    // Câu cứng luôn có tên workspace, không cần tiền tố "Workspace X:" nữa.
    text = doneAnnouncement(answer, cwd, lang);
  } else {
    text = pickSpeech(answer);
    // Nhiều workspace cùng chạy thì người nghe không biết câu trả lời của cửa sổ nào: mở đầu bằng tên workspace.
    if (text && saysWorkspace(cfg)) text = `Workspace ${workspaceName(cwd, lang)}: ${text}`;
  }
  // Hands-free: extension mở mic sau khi loa phát xong. Tiến trình play gửi tín hiệu listen khi xong;
  // không có gì để đọc thì gửi ngay từ đây.
  const listenCwd = cfg.handsFree && !waiting ? cwd : undefined;
  if (text) {
    // Shell chạy hook CLI thoát ngay sau hook; lấy chuỗi pid trước khi tách play.
    const ancestors = listenCwd && sourceArg() === 'copilot-cli' ? await claudeAncestors(process.ppid, session) : undefined;
    spawnPlay(text, 'speak', session, lang, listenCwd, ancestors);
  }
  else if (listenCwd) {
    await requestMicrophone({ event: 'listen', session, cwd: listenCwd });
  }
  // Nháy cửa sổ mất gần một giây (PowerShell): tách play trước rồi mới chờ, để giọng đọc không bị chậm theo.
  await attentionSent;
}

/** auto: có hơn một cửa sổ VS Code đăng ký (sổ trong WINDOWS_DIR) thì mới cần nói tên. */
function saysWorkspace(cfg: HookConfig): boolean {
  const mode = cfg.voiceSayWorkspace ?? 'auto';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return readRegistry().length > 1;
}

/** Bỏ qua bản đang đọc: tắt player của vé đầu hàng để tiến trình play kết thúc sớm mà vẫn báo hands-free; chưa có player thì tắt luôn tiến trình. */
function modeSkip(): void {
  const head = listTickets()[0];
  if (!head) {
    log('skip: không có gì đang đọc');
    return;
  }
  if (head.t.player) {
    kill(head.t.player);
    log(`skip: tắt player ${head.t.player} của vé ${head.file}`);
  } else {
    kill(head.t.pid);
    log(`skip: tắt tiến trình play ${head.t.pid} của vé ${head.file} (chưa phát)`);
  }
}

/** Tách tiến trình phát rồi thoát ngay để Claude Code không phải chờ. listenCwd: phát xong thì báo extension mở mic. */
function spawnPlay(raw: string, kind: Ticket['kind'], session: string, lang: Lang, listenCwd?: string, ancestors?: number[]): void {
  if (!speechEnabled(kind) && !listenCwd) return;
  // Giọng vi-VN đọc sai chữ viết tắt và đuôi file tiếng Anh; viết sẵn cách đọc trước khi tổng hợp.
  // Tiếng Anh hoặc giọng đa ngôn ngữ thì bỏ bảng mặc định (nó phiên âm sang tiếng Việt), chỉ giữ bảng của người dùng.
  const voice = voiceFor(lang);
  const text = pronounce(raw, loadConfig().pronunciations, usesVietPronunciation(voice, lang));
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const file = path.join(WORK_DIR, `say-${Date.now()}-${process.pid}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  const args = [__filename, 'play', file, '--voice', voice, '--rate', arg('rate', '+0%'), '--player', arg('player', 'ffplay')];
  args.push('--kind', kind, '--session', session || '-');
  if (permissionPlayback) args.push('--permission-transcript', permissionPlayback.transcript, '--permission-request', permissionPlayback.requestId);
  // play đọc file cấu hình để biết giọng ElevenLabs (key không đi qua dòng lệnh).
  if (arg('config', '')) args.push('--config', arg('config', ''));
  // Tiến trình play tách rời nên không còn biết cha; đưa pid của Claude Code (cha của hook) để nó tra cây tiến trình.
  if (listenCwd) {
    args.push('--listen', listenCwd, '--source', sourceArg(), '--claude-pid', String(process.ppid));
    if (ancestors?.length) args.push('--ancestors', ancestors.join(','));
    // Số prompt của phiên lúc này; play so lại trước khi mở mic để câu cũ không bật mic khi đã có prompt mới.
    if (session) args.push('--prompt-count', String(readMark(session).count));
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  log(`${kind} → play pid ${child.pid} (${voice}): ${JSON.stringify(text)}`);
}

/** Agent gọi hook: --source copilot (file hook Copilot) hay mặc định claude. Đi kèm tín hiệu listen để extension chọn đích. */
function sourceArg(): SignalSource {
  if (inputSource) return inputSource;
  const source = arg('source', 'claude');
  return source === 'copilot-cli' || source === 'copilot' ? source : 'claude';
}

/** Giọng theo ngôn ngữ: tiếng Anh mà --voice là giọng vi-VN thì đổi sang giọng đa ngôn ngữ. */
function voiceFor(lang: Lang): string {
  return effectiveVoice(loadConfig().voice || arg('voice', DEFAULT_VOICE), lang);
}

/**
 * Làm nổi cửa sổ đang chứa agent. Agent ở terminal rời (Windows Terminal, cmd, PowerShell) thì hook tự nháy
 * cửa sổ đó theo console/cây tiến trình của mình; ở VS Code (hay không tìm thấy) thì nhờ extension của cửa sổ
 * có cwd này nháy taskbar và tô màu. Không có cửa sổ hay lỗi thì thôi, không chặn việc đọc.
 * VI_VOICE_HOST_FLASH=0 tắt bước tự nháy (test chạy hook dưới terminal thật, không được nháy nó).
 */
async function attention(reason: AttentionReason, session: string, cwd: string, cfg: HookConfig = {}): Promise<boolean> {
  // Chuỗi pid tổ tiên của hook: qua Claude Code/Copilot CLI tới shell của terminal, hay qua powershell tới extension
  // host của cửa sổ Copilot Chat. Dùng để nháy terminal rời và để cửa sổ VS Code nào chứa agent tự nhận tín hiệu.
  const ancestors = await claudeAncestors(process.ppid, session);
  if (cfg.attentionFlash === false) log(`attention ${reason}: attentionFlash tắt, không nháy cửa sổ chứa agent`);
  else if (process.env.VI_VOICE_HOST_FLASH !== '0' && process.platform === 'win32') {
    const t0 = Date.now();
    const host = await flashHostWindow(ancestors);
    log(`attention ${reason}: nháy cửa sổ chứa agent → ${host.result}${host.window ? ` (${host.window})` : ''} (${Date.now() - t0}ms)`);
    if (host.result === 'flashed' || host.result === 'foreground') return true;
  }
  return signalAgentWindow({ event: 'attention', session, cwd, reason, ancestors }, undefined, log).catch((err) => {
    log(`signal attention lỗi: ${(err as Error).message}`);
    return false;
  });
}

async function modeNotify(): Promise<void> {
  const input = await readHookInput(arg('event', 'Notification'));
  trackPermissionNotification(input);
  if (permissionCompleted()) return;
  const cfg = loadConfig();
  const chat = sourceArg() === 'copilot';
  if (chat && input.hook_event_name === 'PostToolUse') {
    // Bằng chứng tool đã chạy: extension bỏ lượt chờ "cần approve" của lệnh này (xem chatPending.ts).
    if (input.chat_voice_tool === 'approval' && input.tool_name === 'Bash') {
      await signalWindow({ event: 'chatDone', ...chatToolRef(input) }, undefined, log, false)
        .catch((err) => log(`signal chatDone lỗi: ${(err as Error).message}`));
    }
    return;
  }
  if (chat && (input.hook_event_name !== 'PreToolUse' || !input.chat_voice_tool)) return;
  if (input.question_fallback_reason) log(`chọn: dùng hộp thoại thủ công: ${input.question_fallback_reason}`);
  const elevated = input.tool_input?.requestSandboxBypass === true || (chat &&
    ['requestSandboxBypass', 'requestUnsandboxedExecution', 'requestAllowNetwork'].some((key) => input[key] === true || input.tool_input?.[key] === true));
  const canVoiceApprove = !elevated && voiceApprovable(input.tool_name, input.tool_input);
  if (sourceArg() === 'copilot-cli') {
    // CLI permission hooks run before policy checks, not when a dialog opens.
    if (input.hook_event_name === 'PermissionRequest' && (!cfg.handsFree || !canVoiceApprove)) {
      log('notify: CLI permission preflight, leaving permission handling to CLI without an alert');
      return;
    }
    // Manual questions emit elicitation_dialog when they actually need an answer.
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'AskUserQuestion' &&
        (!cfg.handsFree || input.question_fallback_reason)) {
      log('notify: CLI manual question, waiting for elicitation_dialog');
      return;
    }
  }
  const lang = sessionLang(cfg, input.session_id);
  const say = spoken(lang);
  const approval = input.hook_event_name === 'PermissionRequest' || (chat && input.chat_voice_tool === 'approval');
  // Chat: nói thêm tool và vài từ đầu của lệnh (không đọc nguyên câu lệnh dài), có dấu chấm để câu sau tách ra.
  const text = approval && chat
    ? `${announcement({ ...input, hook_event_name: 'PermissionRequest' }, lang)} ${briefTool(input.tool_name ?? '', input.tool_input)}.`
    : announcement(input, lang);
  log(`notify ${input.hook_event_name ?? '?'} ${input.notification_type ?? input.tool_name ?? ''}: ${JSON.stringify(text)}`);
  if (!text) return;
  if (chat && approval && input.tool_name === 'Bash' && (!cfg.handsFree || !canVoiceApprove)) {
    // Lệnh terminal của Chat mà không duyệt bằng giọng: Chat gọi hook trước mọi tool, kể cả tool sẽ tự duyệt, và
    // không báo khi hộp thoại hiện. Ép hộp thoại bằng 'ask' thì VS Code ẩn menu "Allow in this session/workspace/
    // always", nên chỉ báo extension chờ bằng chứng tool chạy (terminal Copilot mở, lệnh bắt đầu, PostToolUse);
    // hết giờ chờ mới đọc và nháy. Lệnh setting auto-approve của VS Code sẽ tự duyệt thì im luôn.
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    const auto = elevated ? false : (chatWouldAutoApprove(command, cfg.chatAutoApprove) ?? canVoiceApprove);
    if (auto) {
      log(`notify: Chat sẽ tự duyệt ${briefTool(input.tool_name, input.tool_input)}, không đọc`);
      return;
    }
    let reason = text;
    if (cfg.handsFree) {
      const dangerous = isDangerous(input.tool_name, input.tool_input);
      log(`approve: ${input.tool_name} ${dangerous ? 'nguy hiểm' : 'không trong danh sách an toàn'}, không nghe`);
      reason = dangerous ? say.dangerous(text) : say.notSafe(text);
    }
    const sent = await signalWindow({ event: 'chatPending', ...chatToolRef(input), text: reason, lang, source: 'copilot' }, undefined, log, false)
      .catch((err) => { log(`signal chatPending lỗi: ${(err as Error).message}`); return false; });
    if (sent) {
      log(`notify: Chat có thể hỏi duyệt ${briefTool(input.tool_name, input.tool_input)}, extension chờ bằng chứng tool chạy`);
      return;
    }
    // Không có cửa sổ VS Code nhận tín hiệu: ép hộp thoại và đọc như trước, còn hơn im.
    log('notify: không có cửa sổ nhận chatPending, ép hộp thoại và đọc');
    await attention('approve', input.session_id ?? '', input.cwd || process.cwd(), cfg);
    manualChatApproval(cfg.handsFree ? reason : say.announcedByVoice);
    spawnPlay(reason, 'notify', input.session_id ?? '', lang);
    return;
  }
  if (chat && approval && !cfg.handsFree) {
    log('notify: Chat sửa file, Hands Free tắt, không ép hộp thoại');
    return;
  }
  await attention(/approve|approval/i.test(text) ? 'approve' : 'answer', input.session_id ?? '', input.cwd || process.cwd(), cfg);
  if (permissionCompleted()) return;
  if (voiceOff(cfg)) {
    log('notify: voiceResponse tắt, không đọc câu báo');
  }
  if (cfg.voiceNotify === false) {
    log('notify: voiceNotify tắt, không đọc câu báo');
  }
  if (approval && cfg.handsFree) {
    // Danh sách trắng: chỉ tool và lệnh lành mới duyệt bằng giọng; lệnh nguy hiểm hay chưa phân loại thì bấm tay.
    if (!canVoiceApprove) {
      const dangerous = isDangerous(input.tool_name, input.tool_input);
      log(`approve: ${input.tool_name} ${dangerous ? 'nguy hiểm' : 'không trong danh sách an toàn'}, không nghe`);
      const reason = dangerous ? say.dangerous(text) : say.notSafe(text);
      manualChatApproval(reason);
      spawnPlay(reason, 'notify', input.session_id ?? '', lang);
      return;
    }
    await voiceApprove(text, input, cfg, lang);
    return;
  }
  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'AskUserQuestion' && cfg.handsFree) {
    await voiceChoose(text, input, cfg, lang);
    return;
  }
  spawnPlay(text, 'notify', input.session_id ?? '', lang);
}

/**
 * Chọn đáp án bằng giọng: đọc câu hỏi và các lựa chọn, nghe, hiểu số hoặc tên lựa chọn,
 * rồi chặn tool đặt câu hỏi với lý do chứa câu trả lời để Claude làm tiếp. Không rõ thì để hộp thoại hiện.
 */
async function voiceChoose(text: string, input: AgentHookInput, cfg: HookConfig, lang: Lang): Promise<void> {
  const session = input.session_id ?? '';
  const questions = (input.tool_input?.questions ?? []).filter((q) => q?.question);
  if (!questions.length) {
    spawnPlay(text, 'notify', session, lang);
    return;
  }
  const timeoutSec = Math.max(3, cfg.approveTimeoutSec ?? 15);
  const cwd = input.cwd || process.cwd();
  const say = spoken(lang);
  const answers: string[] = [];
  const structuredAnswers: Record<string, unknown> = {};
  if (sourceArg() === 'copilot-cli' && typeof input.tool_input?.message === 'string') {
    await playNow(input.tool_input.message, 'notify', session, lang);
  }
  for (const q of questions) {
    const questionText = sourceArg() === 'copilot' && q.header ? `${q.header}: ${q.question}` : q.question ?? '';
    // Claude hay tự đánh số trong nhãn ("1. Tra tracking"); bỏ đi để không đọc số hai lần.
    const labels = (q.options ?? []).map((o) => {
      const label = (o?.label ?? '').trim();
      return label.replace(/^\d+[.):]\s*/, '') || label;
    }).filter(Boolean);
    const multi = q.multiSelect ? say.multiSelect : '';
    const spokenOptions = labels.length
      ? ` ${labels.map((label, index) => `${index + 1}, ${label}${q.options?.[index]?.description ? `, ${q.options[index].description}` : ''}`).join('. ')}.${multi}${say.chooseAfterBeep}`
      : say.answerAfterBeep;
    await playNow(`${questionText}${spokenOptions}`.trim(), 'notify', session, lang);
    const heard = await askHeard(cwd, session, timeoutSec, 'chọn');
    if (!heard) {
      spawnPlay(say.notHeardChoose, 'notify', session, lang);
      return;
    }
    if (isChoiceCancellation(heard)) {
      spawnPlay(say.okChoose, 'notify', session, lang);
      return;
    }
    if (sourceArg() === 'copilot' && isAmbiguousChoice(heard, labels)) {
      spawnPlay(say.unclearChoose, 'notify', session, lang);
      return;
    }
    if (labels.length) {
      const picked = parseChoice(heard, labels);
      if (picked === undefined) {
        if (q.allowFreeform === true) {
          answers.push(say.answerFree(questionText, heard));
          continue;
        }
        spawnPlay(say.unclearChoose, 'notify', session, lang);
        return;
      }
      if (picked.length === 0) {
        spawnPlay(say.okChoose, 'notify', session, lang);
        return;
      }
      if (!q.multiSelect && picked.length > 1) {
        spawnPlay(say.unclearChoose, 'notify', session, lang);
        return;
      }
      const chosen = picked.map((index) => sourceArg() === 'copilot' ? q.options?.[index]?.label ?? labels[index] : labels[index]);
      if (q.key && q.values) {
        const values = picked.map((i) => q.values?.[i]);
        structuredAnswers[q.key] = q.multiSelect ? values : values[0];
      } else {
        answers.push(say.answerChoice(questionText, chosen));
      }
      await playNow(say.chosen(chosen), 'notify', session, lang);
    } else {
      if (q.key) {
        if (q.valueType === 'number' || q.valueType === 'integer') {
          const number = Number(heard);
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(heard) || !Number.isFinite(number) || (q.valueType === 'integer' && !Number.isSafeInteger(number))) {
            spawnPlay(say.unclearChoose, 'notify', session, lang);
            return;
          }
          structuredAnswers[q.key] = number;
        } else {
          structuredAnswers[q.key] = heard;
        }
      } else {
        answers.push(say.answerFree(questionText, heard));
      }
    }
  }
  if (Object.keys(structuredAnswers).length) answers.push(JSON.stringify(structuredAnswers));
  log(`chọn → ${answers.join(' | ')}`);
  const decision = { permissionDecision: 'deny', permissionDecisionReason: say.chooseReason(answers) };
  process.stdout.write(JSON.stringify(sourceArg() === 'copilot-cli'
    ? decision
    : {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        ...decision,
      },
    }));
}

/**
 * Approve bằng giọng: đọc thông báo (chờ đọc xong), mở mic nghe một câu, hỏi Whisper,
 * rồi trả quyết định cho Claude Code. Không rõ hoặc im lặng thì không trả gì, hộp thoại hiện như thường.
 */
/** Phần nhận diện một tool của Chat trong tín hiệu chatPending/chatDone: phiên, cwd, tool_use_id và câu lệnh. */
function chatToolRef(input: AgentHookInput): { session: string; cwd: string; toolUseId?: string; command?: string } {
  const toolUseId = (input as Record<string, unknown>).tool_use_id;
  const command = input.tool_input?.command;
  return {
    session: input.session_id ?? '',
    cwd: input.cwd || process.cwd(),
    ...(typeof toolUseId === 'string' && toolUseId ? { toolUseId } : {}),
    ...(typeof command === 'string' ? { command } : {}),
  };
}

function manualChatApproval(reason: string): void {
  if (sourceArg() !== 'copilot') return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }));
}

async function voiceApprove(text: string, input: HookInput & { session_id?: string }, cfg: HookConfig, lang: Lang): Promise<void> {
  const session = input.session_id ?? '';
  const t0 = Date.now();
  const say = spoken(lang);
  await playNow(say.sayApproveOrDeny(text), 'notify', session, lang);
  const heard = await askHeard(input.cwd || process.cwd(), session, Math.max(3, cfg.approveTimeoutSec ?? 15), 'approve');
  if (!heard) {
    manualChatApproval(say.notHeardPress);
    spawnPlay(say.notHeardPress, 'notify', session, lang);
    return;
  }
  const decision = parseApproval(heard);
  log(`approve: nghe ${JSON.stringify(heard)} → ${decision ?? 'không rõ'} (${Date.now() - t0}ms)`);
  if (!decision) {
    manualChatApproval(say.unclearPress);
    spawnPlay(say.unclearPress, 'notify', session, lang);
    return;
  }
  spawnPlay(decision === 'allow' ? say.approved : say.denied, 'notify', session, lang);
  // PermissionRequest dùng decision.behavior, không phải permissionDecision như PreToolUse.
  const reason = say.approveReason(decision, heard);
  process.stdout.write(JSON.stringify(sourceArg() === 'copilot-cli'
    ? { behavior: decision, ...(decision === 'deny' ? { message: reason } : {}) }
    : sourceArg() === 'copilot'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }
      : permissionRequestOutput(decision, reason)));
}

function speechEnabled(kind: Ticket['kind']): boolean {
  const cfg = loadConfig();
  return !voiceOff(cfg) && (kind !== 'notify' || cfg.voiceNotify !== false);
}

/** Phát ngay trong tiến trình này và chờ phát xong (vẫn xếp hàng chung). */
async function playNow(text: string, kind: Ticket['kind'], session: string, lang: Lang): Promise<void> {
  if (!speechEnabled(kind)) return;
  const ticket = takeTicket(kind, session);
  await waitTurn(ticket);
  if (speechEnabled(kind)) await playText(text, ticket, voiceFor(lang));
  try {
    fs.unlinkSync(ticketPath(ticket));
  } catch {
    /* bỏ qua */
  }
}

/** Một yêu cầu Edge trên kết nối mới; quá SYNTH_TIMEOUT_MS thì đóng kết nối để không treo vô hạn. */
const SYNTH_TIMEOUT_MS = 20_000;

async function synthOnce(voice: string, rate: string, text: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  const timer = setTimeout(() => tts.close(), SYNTH_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate });
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (c: Buffer) => chunks.push(c));
      audioStream.on('error', reject);
      audioStream.on('end', resolve);
    });
  } finally {
    clearTimeout(timer);
    tts.close();
  }
  if (chunks.length === 0) throw new Error('Edge không trả audio');
  return Buffer.concat(chunks);
}

const CACHE_DIR = path.join(WORK_DIR, 'cache');
const CACHE_MAX_CHARS = 60;

/** Câu ngắn cố định ("Mình nghe.", "Đã approve.") được cache ra đĩa để phát tức thì thay vì chờ Edge 3 giây. */
function cachePath(voice: string, rate: string, text: string): string {
  const key = crypto.createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex');
  return path.join(CACHE_DIR, `${key}.mp3`);
}

/** Cấu hình giọng ElevenLabs nếu người dùng chọn provider đó và đã có key; không thì undefined (dùng Edge). */
function elevenConfig(): Required<Pick<TtsConfig, 'elevenLabsApiKey'>> & TtsConfig | undefined {
  const t = loadConfig().tts;
  if (!t || t.provider !== 'elevenlabs') return undefined;
  if (!t.elevenLabsApiKey) {
    log('tts: chọn ElevenLabs nhưng chưa có key, dùng Edge');
    return undefined;
  }
  return { ...t, elevenLabsApiKey: t.elevenLabsApiKey };
}

/** Tên giọng ghi vào khoá cache: ElevenLabs thì theo voice id và model, để đổi giọng không dính audio cũ. */
function cacheVoice(voice: string, eleven: TtsConfig | undefined): string {
  return eleven ? `eleven|${eleven.elevenLabsVoiceId ?? ''}|${eleven.elevenLabsModel ?? ''}` : voice;
}

/**
 * Độ trễ của Edge rất thất thường: cùng một câu lúc nửa giây, lúc sáu đến mười hai giây, thỉnh thoảng đóng kết nối
 * giữa chừng. Loa chỉ có đệm bằng phần audio đã tổng hợp trước đó (một khối ~5-13 giây), nên một cú chậm là im tiếng.
 * Vì thế: quá HEDGE_MS chưa về thì mở thêm yêu cầu song song lấy cái nào về trước; lỗi thì thử lại ngay, không giãn cách.
 */
const HEDGE_MS = 2500;
const MAX_ATTEMPTS = 4;
/** Số khối tổng hợp song song phía trước loa. 3 khối x tối đa 2 kết nối hedge = tối đa 6 kết nối Edge cùng lúc. */
const SYNTH_AHEAD = 3;
/** Chờ khối hai tối đa bao lâu trước khi phát khối đầu. */
const FIRST_HOLD_MS = 4000;

/**
 * ElevenLabs ổn định hơn Edge và tính credit theo ký tự, nên không mở yêu cầu song song (hedge) mà chỉ thử lại
 * một lần khi lỗi. Vẫn lỗi (key sai, hết credit, mất mạng) thì lùi về Edge cho câu đó để người nghe không mất tiếng.
 */
const ELEVEN_ATTEMPTS = 2;

async function synthEleven(eleven: TtsConfig & { elevenLabsApiKey: string }, rate: string, text: string): Promise<Buffer> {
  return hedged(
    () =>
      synthElevenLabs({
        apiKey: eleven.elevenLabsApiKey,
        voiceId: eleven.elevenLabsVoiceId,
        model: eleven.elevenLabsModel,
        text,
        speed: rateToSpeed(rate),
        timeoutMs: SYNTH_TIMEOUT_MS,
      }),
    { hedgeMs: SYNTH_TIMEOUT_MS, maxAttempts: ELEVEN_ATTEMPTS, maxInFlight: 1, onEvent: (m) => log(`elevenlabs ${m}`) },
  );
}

async function synthEdge(voice: string, rate: string, text: string): Promise<Buffer> {
  return hedged(() => synthOnce(voice, rate, text), {
    hedgeMs: HEDGE_MS,
    maxAttempts: MAX_ATTEMPTS,
    onEvent: (m) => log(`tts ${m}`),
  });
}

/** Lượt này có câu nào tốn credit ElevenLabs không; có thì sau khi đọc xong hỏi lại số credit còn lại cho status bar. */
let elevenSpent = false;
/** Đã báo "hết credit, dùng Edge" trong tiến trình này chưa, để log một lần thay vì mỗi câu. */
let elevenExhaustedLogged = false;

async function refreshElevenUsage(eleven: TtsConfig & { elevenLabsApiKey: string }): Promise<void> {
  try {
    const u = await fetchUsage(eleven.elevenLabsApiKey);
    writeUsage(u);
    log(`elevenlabs credit còn ${formatUsage(u)} (${u.tier})`);
  } catch (err) {
    log(`elevenlabs không lấy được credit: ${(err as Error).message}`);
  }
}

async function reportElevenUsage(): Promise<void> {
  const eleven = elevenConfig();
  if (!eleven || !elevenSpent) return;
  await refreshElevenUsage(eleven);
}

async function synth(voice: string, rate: string, text: string): Promise<Buffer> {
  const eleven = elevenConfig();
  const cacheable = text.length <= CACHE_MAX_CHARS;
  const file = cachePath(cacheVoice(voice, eleven), rate, text);
  if (cacheable) {
    try {
      return fs.readFileSync(file);
    } catch {
      /* chưa có */
    }
  }
  let audio: Buffer;
  if (eleven && elevenExhausted(readUsage(), text.length)) {
    // Hết credit từ lượt trước: đi thẳng Edge, không gọi ElevenLabs lỗi hai lần cho từng câu.
    if (!elevenExhaustedLogged) {
      const u = readUsage();
      log(`elevenlabs hết credit (${u ? formatUsage(u) : '?'}), đọc bằng Edge (${voice}) tới kỳ reset`);
      elevenExhaustedLogged = true;
    }
    audio = await synthEdge(voice, rate, text);
  } else if (eleven) {
    try {
      audio = await synthEleven(eleven, rate, text);
      elevenSpent = true;
    } catch (err) {
      log(`elevenlabs lỗi, đọc câu này bằng Edge (${voice}): ${(err as Error).message}`);
      // Hết credit: ghi số liệu ngay để các câu sau (và status bar) biết mà không gọi lại.
      if (isQuotaError(err)) await refreshElevenUsage(eleven);
      return synthEdge(voice, rate, text);
    }
  } else {
    audio = await synthEdge(voice, rate, text);
  }
  if (cacheable) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, audio);
    } catch {
      /* bỏ qua */
    }
  }
  return audio;
}

async function modePlay(): Promise<void> {
  const permissionTranscript = arg('permission-transcript', '');
  const permissionRequest = arg('permission-request', '');
  if (permissionTranscript && permissionRequest) permissionPlayback = { transcript: permissionTranscript, requestId: permissionRequest };
  const file = process.argv[3];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return;
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const kind = (arg('kind', 'speak') === 'notify' ? 'notify' : 'speak') as Ticket['kind'];
  const session = arg('session', '-');
  const ticket = takeTicket(kind, session === '-' ? '' : session);
  // Tra cây tiến trình song song với lúc chờ và đọc, để không làm chậm việc mở mic.
  const listenCwd = arg('listen', '');
  const savedAncestors = arg('ancestors', '').split(',').map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const ancestors = savedAncestors.length
    ? Promise.resolve(savedAncestors)
    : listenCwd ? claudeAncestors(Number(arg('claude-pid', '0')), session === '-' ? '' : session) : Promise.resolve([]);
  await waitTurn(ticket);
  // --voice ở đây đã được spawnPlay chọn theo ngôn ngữ.
  if (!arg('kind', '') || speechEnabled(kind)) await playText(text, ticket, arg('voice', DEFAULT_VOICE));
  try {
    fs.unlinkSync(file);
  } catch {
    /* bỏ qua */
  }
  // Chạy song song với việc mở mic để không làm chậm; tiến trình chờ nó xong trước khi thoát.
  const usage = reportElevenUsage();
  // Hands-free: loa vừa im, giờ mới bảo extension mở mic để không nghe nhầm giọng Claude.
  if (listenCwd) {
    // Người dùng đã gửi prompt mới trong lúc câu này còn đang đọc: Claude đang làm lượt mới, mở mic lúc này thì tiếng
    // nói vô tình bị gõ vào terminal. Số prompt của phiên lúc tách play khác số hiện tại là bỏ qua.
    const promptCount = arg('prompt-count', '');
    const nowCount = session !== '-' && promptCount ? readMark(session).count : undefined;
    if (nowCount !== undefined && String(nowCount) !== promptCount) {
      log(`listen: phiên ${session} đã có prompt mới (${promptCount} → ${nowCount}), không mở mic`);
      await usage;
      return;
    }
    await signalWindow(
      { event: 'listen', session: session === '-' ? '' : session, cwd: listenCwd, source: sourceArg(), ancestors: await ancestors },
      undefined,
      log,
    );
  }
  await usage;
}

/** Tổng hợp từng khối và đưa vào ffplay; trả về khi phát xong hoặc bị cắt. */
/**
 * Mic của một cửa sổ đang mở (người dùng đang nói) thì không phát gì, không thì mic nghe luôn giọng đọc.
 * Chờ tối đa MIC_WAIT_MS rồi phát dù sao, để không kẹt mãi nếu khoá mic bị bỏ quên.
 */
/**
 * Chờ tới khi không cửa sổ nào giữ mic (khoá mic tự hết hạn sau MIC_LOCK_MAX_AGE_MS nếu chủ khoá quên trả).
 * Quá MIC_WAIT_MS mà mic vẫn mở thì bỏ lượt phát này, không phát chen vào lúc đang thu.
 */
const MIC_WAIT_MS = Number(process.env.VI_VOICE_MIC_WAIT_MS) || MIC_LOCK_MAX_AGE_MS + 10_000;
async function waitMicFree(): Promise<boolean> {
  const t0 = Date.now();
  let waited = false;
  while (micHolder() !== undefined) {
    if (Date.now() - t0 >= MIC_WAIT_MS) {
      log(`play: mic vẫn mở sau ${Date.now() - t0}ms, bỏ lượt phát`);
      return false;
    }
    waited = true;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (waited) log(`play: mic cửa sổ khác đang mở, đã chờ ${Date.now() - t0}ms`);
  return true;
}

async function playText(text: string, ticket: string, voice: string): Promise<void> {
  if (!(await waitMicFree())) return;
  if (permissionCompleted()) return;
  const t0 = Date.now();
  const rate = arg('rate', '+0%');
  // --player là tên trần (settings cũ) hay đường dẫn không còn (ffmpeg dời chỗ) thì tìm lại theo registry PATH
  // và thư mục winget/choco/scoop; shell chạy Claude có PATH cũ cũng không sao.
  const playerExe = await resolvePlayer(arg('player', 'ffplay'));
  if (playerExe !== arg('player', 'ffplay')) log(`player: ${arg('player', 'ffplay')} → ${playerExe}`);

  const player = spawn(
    playerExe,
    ['-nodisp', '-autoexit', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0'],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  updateTicket(ticket, { player: player.pid });
  let stopped = false;
  let failed = false;
  let cancelled = false;
  let stderrTail = '';
  player.stderr.setEncoding('utf8');
  player.stderr.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4096); });
  player.stdin.on('error', () => undefined); // ffplay bị tắt giữa chừng thì bỏ qua EPIPE
  player.on('error', (e) => {
    log(`không chạy được player: ${e.message}`);
    failed = true;
    stopped = true;
  });
  player.on('exit', () => (stopped = true));
  const finished = new Promise<void>((resolve) => {
    player.once('close', (code, signal) => {
      if (!failed && !cancelled && code !== 0) {
        failed = true;
        log(`player exited with code ${code}${signal ? ` (${signal})` : ''}: ${stderrTail.trim() || 'no stderr'}`);
      }
      resolve();
    });
  });

  // Đường ống: luôn có SYNTH_AHEAD khối đang tổng hợp (khối đang chờ phát và các khối sau), đưa vào ffplay theo
  // thứ tự. Edge có lúc mất 5-8 giây một khối trong khi khối đầu chỉ phát ~5 giây, tổng hợp một khối phía trước
  // là không đủ, loa im giữa chừng. Mỗi khối tối đa hai kết nối song song khi Edge chậm (xem synth).
  const sentences = splitSentences(text);
  await prefetchInOrder(sentences, {
    ahead: SYNTH_AHEAD,
    produce: (s) => synth(voice, rate, s),
    stopped: () => stopped,
    consume: async (audio, i, next) => {
      if (i === 0) {
        log(`câu đầu sẵn sàng sau ${Date.now() - t0}ms (${sentences.length} câu)`);
        // Khối đầu chỉ vài giây; nếu khối hai chưa xong thì loa sẽ im giữa câu. Chờ khối hai một chút
        // để im lặng dồn về đầu (nghe như đang nghĩ) thay vì kẹt giữa chừng. Không chờ quá FIRST_HOLD_MS.
        if (next) {
          const held = Date.now();
          await Promise.race([next.catch(() => undefined), new Promise((r) => setTimeout(r, FIRST_HOLD_MS))]);
          const ms = Date.now() - held;
          if (ms > 100) log(`giữ câu đầu ${ms}ms chờ câu hai`);
        }
      }
      if (!stopped && permissionCompleted()) {
        cancelled = true;
        stopped = true;
        player.kill();
      }
      if (!stopped) player.stdin.write(audio);
    },
    onError: (err, i) => log(`bỏ câu ${i + 1}: ${err.message}`),
  });
  player.stdin.end();
  await finished;
  if (!failed && !cancelled) log(`phát xong sau ${Date.now() - t0}ms`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  // Extension gọi `claude -p` để dịch recapPrompt: tiến trình đó kế thừa hook này, từng làm tắt mic và đọc "done" giả.
  if (process.env.NOIDLE_INTERNAL === '1') {
    log(`${mode}: NOIDLE_INTERNAL, agent do NoIdle gọi, bỏ qua`);
    return;
  }
  if (mode === 'start') return modeStart();
  if (mode === 'prompt') return modePrompt();
  if (mode === 'speak') return modeSpeak();
  if (mode === 'play') return modePlay();
  if (mode === 'notify') return modeNotify();
  if (mode === 'skip') return modeSkip();
  process.stderr.write('usage: claude-hook.js start | prompt | speak | notify | play <file>\n');
  process.exitCode = 2;
}

main().catch((err) => {
  log(`lỗi ${process.argv[2]}: ${(err as Error).stack ?? err}`);
  // Hook không được làm Claude Code lỗi theo.
  process.exitCode = 0;
});
