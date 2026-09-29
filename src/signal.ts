/**
 * Kênh tín hiệu hook → extension. Mỗi cửa sổ VS Code mở một server trên named pipe và ghi một
 * file đăng ký (pid, pipe, workspace folders) vào WINDOWS_DIR. Hook tìm cửa sổ theo cwd rồi gửi
 * một dòng JSON: listen (mở mic nghe lệnh tiếp), submitted (người dùng đã gửi prompt), ask (nghe một câu
 * rồi trả chữ về), hoặc attention (làm nổi cửa sổ: Claude xong, cần approve, cần trả lời). Khung tin: mỗi thông điệp một dòng kết thúc bằng xuống dòng; ask được server trả lời bằng một dòng
 * {heard} rồi đóng kết nối, các tín hiệu khác thì đóng ngay.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface WindowEntry {
  pid: number;
  pipe: string;
  folders: string[];
}

/** resumed: việc nền xong, Claude chạy tiếp; extension bỏ trạng thái "done" (không đụng mic). */
export type SignalEvent = 'listen' | 'submitted' | 'ask' | 'attention' | 'resumed';
/** attention: vì sao cửa sổ cần người dùng. */
export type AttentionReason = 'done' | 'approve' | 'answer';
export type SignalSource = 'claude' | 'copilot' | 'copilot-cli';
export interface Signal {
  event: SignalEvent;
  session: string;
  cwd: string;
  /** ask: chờ người dùng nói tối đa bao nhiêu giây. */
  timeoutSec?: number;
  /** Terminal cho Claude Code/Copilot CLI; ô chat cho Copilot Chat. */
  source?: SignalSource;
  /** listen/ask: pid của Claude Code rồi cha, ông... để extension tìm terminal có shell pid trong chuỗi này. */
  ancestors?: number[];
  /** attention: Claude xong, cần approve hay cần trả lời; extension nháy taskbar và đổi màu status bar. */
  reason?: AttentionReason;
}

/** Trả lời của server cho ask; các tín hiệu khác không có trả lời. */
export type SignalHandler = (s: Signal) => void | string | Promise<void | string>;

export function canAutoListen(
  signal: Pick<Signal, 'event' | 'reason'>,
  settings: { voiceResponse: boolean; handsFree: boolean },
): boolean {
  if (signal.event === 'listen') return settings.handsFree;
  if (signal.event !== 'ask') return false;
  if (signal.reason === 'approve' || signal.reason === 'answer') return settings.handsFree;
  return false;
}

export const WINDOWS_DIR = path.join(os.tmpdir(), 'noidle-tts', 'windows');

export function pipeName(pid: number): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\noidle-${pid}` : path.join(os.tmpdir(), `noidle-${pid}.sock`);
}

function normPath(p: string, caseInsensitive: boolean): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? s.toLowerCase() : s;
}

/** Cửa sổ có workspace folder là tiền tố dài nhất của cwd (đúng ranh giới thư mục). */
export function pickWindow(entries: WindowEntry[], cwd: string, caseInsensitive = process.platform === 'win32'): WindowEntry | undefined {
  const target = normPath(cwd, caseInsensitive);
  let best: WindowEntry | undefined;
  let bestLen = -1;
  for (const e of entries) {
    for (const f of e.folders) {
      const folder = normPath(f, caseInsensitive);
      if (!folder) continue;
      const hit = target === folder || target.startsWith(folder + '/');
      if (hit && folder.length > bestLen) {
        best = e;
        bestLen = folder.length;
      }
    }
  }
  return best;
}

export function parseSignal(line: string): Signal | undefined {
  try {
    const o = JSON.parse(line.trim()) as Partial<Signal>;
    if ((o.event !== 'listen' && o.event !== 'submitted' && o.event !== 'ask' && o.event !== 'attention') || typeof o.cwd !== 'string') return undefined;
    const out: Signal = { event: o.event, session: typeof o.session === 'string' ? o.session : '', cwd: o.cwd };
    if (typeof o.timeoutSec === 'number') out.timeoutSec = o.timeoutSec;
    if (o.source === 'claude' || o.source === 'copilot' || o.source === 'copilot-cli') out.source = o.source;
    if (Array.isArray(o.ancestors)) out.ancestors = o.ancestors.filter((n): n is number => typeof n === 'number');
    if (o.reason === 'done' || o.reason === 'approve' || o.reason === 'answer') out.reason = o.reason;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Khoá mic dùng chung cho mọi cửa sổ VS Code: một file trong thư mục tạm ghi pid đang giữ mic.
 * Không có nó thì workspace A đang nghe, B đọc xong cũng mở mic, cả hai nhận cùng một câu.
 * Khoá của tiến trình đã chết hoặc quá MIC_LOCK_MAX_AGE_MS bị coi như không có.
 */
export const MIC_LOCK_MAX_AGE_MS = 5 * 60_000;
const MIC_LOCK = 'mic.lock';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** pid đang giữ mic, hoặc undefined nếu không ai giữ (hay khoá đã chết/cũ). */
export function micHolder(dir = WINDOWS_DIR, alive: (pid: number) => boolean = pidAlive): number | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, MIC_LOCK), 'utf8')) as { pid?: unknown; at?: unknown };
    const pid = Number(o.pid);
    const at = Number(o.at);
    if (!pid || !at || Date.now() - at > MIC_LOCK_MAX_AGE_MS || !alive(pid)) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * Xin giữ mic cho pid; false nếu cửa sổ khác còn sống đang giữ. Cùng pid xin lại thì được.
 * force: người dùng bấm F6 ở cửa sổ này nên vẫn lấy (cửa sổ kia sẽ tự tắt khi hết giờ im lặng).
 */
export function acquireMic(pid: number, dir = WINDOWS_DIR, alive: (pid: number) => boolean = pidAlive, force = false): boolean {
  const file = path.join(dir, MIC_LOCK);
  const data = JSON.stringify({ pid, at: Date.now() });
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return true; // không có thư mục tạm thì thôi khoá, vẫn cho nghe
  }
  // Chiếm khoá nguyên tử bằng tạo file kiểu exclusive; hai cửa sổ cùng xin một lúc thì chỉ một cái tạo được.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true;
    }
    const holder = micHolder(dir, alive);
    if (holder !== undefined && holder !== pid && !force) return false;
    // Khoá cũ, chết, của chính mình, hoặc bị ép: xoá rồi thử tạo lại.
    try {
      fs.unlinkSync(file);
    } catch {
      /* ai đó vừa xoá */
    }
  }
  return false;
}

/** Gửi tín hiệu tới đúng cửa sổ có pid này (theo file đăng ký), ví dụ bảo cửa sổ đang giữ mic tắt mic. */
export async function signalPid(pid: number, signal: Signal, dir = WINDOWS_DIR): Promise<boolean> {
  const entry = readRegistry(dir).find((e) => e.pid === pid);
  if (!entry) return false;
  return sendSignal(entry.pipe, signal);
}

/** Trả mic nếu chính pid này đang giữ. */
export function releaseMic(pid: number, dir = WINDOWS_DIR): void {
  const file = path.join(dir, MIC_LOCK);
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    if (Number(o.pid) !== pid) return;
    fs.unlinkSync(file);
  } catch {
    /* không có khoá */
  }
}

export function readRegistry(dir = WINDOWS_DIR): WindowEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: WindowEntry[] = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as WindowEntry;
      if (typeof e.pid === 'number' && typeof e.pipe === 'string' && Array.isArray(e.folders)) out.push(e);
    } catch {
      /* file hỏng, bỏ */
    }
  }
  return out;
}

export function writeRegistry(entry: WindowEntry, dir = WINDOWS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  return file;
}

export function removeRegistry(pid: number, dir = WINDOWS_DIR): void {
  try {
    fs.unlinkSync(path.join(dir, `${pid}.json`));
  } catch {
    /* đã mất */
  }
}

/**
 * Server nhận tín hiệu: mỗi kết nối gửi một dòng JSON. Handler trả string thì đó là trả lời cho ask,
 * server ghi {heard} rồi đóng; không thì đóng ngay. Lỗi socket được bỏ qua.
 */
export function startServer(pipe: string, handler: SignalHandler): net.Server {
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(pipe);
    } catch {
      /* chưa có */
    }
  }
  const server = net.createServer((socket) => {
    let data = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    const handle = (line: string) => {
      const s = parseSignal(line);
      if (!s) {
        socket.end();
        return;
      }
      Promise.resolve()
        .then(() => handler(s))
        .then((reply) => {
          if (typeof reply === 'string') socket.write(JSON.stringify({ heard: reply }) + '\n');
        })
        .catch(() => undefined)
        .then(() => socket.end());
    };
    socket.on('data', (d) => {
      if (handled) return;
      data += d;
      const nl = data.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      handle(data.slice(0, nl));
    });
    socket.on('end', () => {
      if (!handled && data.trim()) {
        handled = true;
        handle(data);
      }
    });
  });
  server.on('error', () => undefined);
  server.listen(pipe);
  return server;
}

/** Gửi một tín hiệu; true nếu bên kia nhận (đóng kết nối bình thường), false nếu lỗi hoặc hết giờ. */
export function sendSignal(pipe: string, signal: Signal, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const socket = net.connect(pipe, () => {
      socket.end(JSON.stringify(signal) + '\n');
    });
    socket.on('error', () => finish(false));
    socket.on('close', (hadError) => finish(!hadError));
  });
}

/** Tìm cửa sổ theo cwd trong registry và gửi tín hiệu. Cửa sổ không trả lời thì xoá entry. */
/** prune: cửa sổ không trả lời thì xoá đăng ký (mặc định). Tín hiệu phụ như attention để false, việc dọn để listen/submitted lo. */
export async function signalWindow(signal: Signal, dir = WINDOWS_DIR, log?: (m: string) => void, prune = true): Promise<boolean> {
  const entry = pickWindow(readRegistry(dir), signal.cwd);
  if (!entry) {
    log?.(`signal ${signal.event}: không có cửa sổ nào cho ${signal.cwd}`);
    return false;
  }
  const ok = await sendSignal(entry.pipe, signal);
  if (!ok) {
    log?.(`signal ${signal.event}: cửa sổ pid ${entry.pid} không trả lời${prune ? ', xoá đăng ký' : ''}`);
    if (prune) removeRegistry(entry.pid, dir);
  } else log?.(`signal ${signal.event} → cửa sổ pid ${entry.pid}`);
  return ok;
}

/** Gửi ask và chờ dòng trả lời {heard}. undefined nếu không nối được, lỗi, hoặc hết giờ. */
export function askSignal(pipe: string, signal: Signal, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let data = '';
    const finish = (heard: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(heard);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const socket = net.connect(pipe, () => {
      socket.write(JSON.stringify(signal) + '\n');
    });
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      data += d;
      const nl = data.indexOf('\n');
      if (nl < 0) return;
      try {
        const o = JSON.parse(data.slice(0, nl)) as { heard?: unknown };
        finish(typeof o.heard === 'string' ? o.heard : undefined);
      } catch {
        finish(undefined);
      }
    });
    socket.on('error', () => finish(undefined));
    socket.on('close', () => finish(undefined));
  });
}

/** Tìm cửa sổ theo cwd rồi hỏi; chờ thêm 20 giây ngoài timeoutSec cho Whisper. undefined nếu không có cửa sổ hoặc lỗi. */
export async function askWindow(signal: Signal, dir = WINDOWS_DIR, log?: (m: string) => void): Promise<string | undefined> {
  const entry = pickWindow(readRegistry(dir), signal.cwd);
  if (!entry) {
    log?.(`ask: không có cửa sổ nào cho ${signal.cwd}`);
    return undefined;
  }
  const heard = await askSignal(entry.pipe, signal, ((signal.timeoutSec ?? 15) + 20) * 1000);
  if (heard === undefined) {
    log?.(`ask: cửa sổ pid ${entry.pid} không trả lời`);
    return undefined;
  }
  log?.(`ask → cửa sổ pid ${entry.pid}: ${JSON.stringify(heard)}`);
  return heard;
}
