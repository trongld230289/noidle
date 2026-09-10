/**
 * Kênh tín hiệu hook → extension. Mỗi cửa sổ VS Code mở một server trên named pipe và ghi một
 * file đăng ký (pid, pipe, workspace folders) vào WINDOWS_DIR. Hook tìm cửa sổ theo cwd rồi gửi
 * một dòng JSON: listen (mở mic nghe lệnh tiếp), submitted (người dùng đã gửi prompt), hoặc ask (nghe một câu
 * rồi trả chữ về). Khung tin: mỗi thông điệp một dòng kết thúc bằng xuống dòng; ask được server trả lời bằng một dòng
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

export type SignalEvent = 'listen' | 'submitted' | 'ask';
export interface Signal {
  event: SignalEvent;
  session: string;
  cwd: string;
  /** ask: chờ người dùng nói tối đa bao nhiêu giây. */
  timeoutSec?: number;
}

/** Trả lời của server cho ask; các tín hiệu khác không có trả lời. */
export type SignalHandler = (s: Signal) => void | string | Promise<void | string>;

export const WINDOWS_DIR = path.join(os.tmpdir(), 'vi-voice-tts', 'windows');

export function pipeName(pid: number): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\vi-voice-${pid}` : path.join(os.tmpdir(), `vi-voice-${pid}.sock`);
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
    if ((o.event !== 'listen' && o.event !== 'submitted' && o.event !== 'ask') || typeof o.cwd !== 'string') return undefined;
    const out: Signal = { event: o.event, session: typeof o.session === 'string' ? o.session : '', cwd: o.cwd };
    if (typeof o.timeoutSec === 'number') out.timeoutSec = o.timeoutSec;
    return out;
  } catch {
    return undefined;
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
export async function signalWindow(signal: Signal, dir = WINDOWS_DIR, log?: (m: string) => void): Promise<boolean> {
  const entry = pickWindow(readRegistry(dir), signal.cwd);
  if (!entry) {
    log?.(`signal ${signal.event}: không có cửa sổ nào cho ${signal.cwd}`);
    return false;
  }
  const ok = await sendSignal(entry.pipe, signal);
  if (!ok) {
    log?.(`signal ${signal.event}: cửa sổ pid ${entry.pid} không trả lời, xoá đăng ký`);
    removeRegistry(entry.pid, dir);
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
