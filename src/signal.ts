/**
 * Kênh tín hiệu hook → extension. Mỗi cửa sổ VS Code mở một server trên named pipe và ghi một
 * file đăng ký (pid, pipe, workspace folders) vào WINDOWS_DIR. Hook tìm cửa sổ theo cwd rồi gửi
 * một dòng JSON: listen (mở mic nghe lệnh tiếp) hoặc submitted (người dùng đã gửi prompt).
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

export type SignalEvent = 'listen' | 'submitted';
export interface Signal {
  event: SignalEvent;
  session: string;
  cwd: string;
}

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
    if ((o.event !== 'listen' && o.event !== 'submitted') || typeof o.cwd !== 'string') return undefined;
    return { event: o.event, session: typeof o.session === 'string' ? o.session : '', cwd: o.cwd };
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

/** Server nhận tín hiệu: mỗi kết nối gửi một dòng JSON rồi đóng. Lỗi socket được bỏ qua. */
export function startServer(pipe: string, onSignal: (s: Signal) => void): net.Server {
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(pipe);
    } catch {
      /* chưa có */
    }
  }
  const server = net.createServer((socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => (data += d));
    socket.on('error', () => undefined);
    socket.on('end', () => {
      for (const line of data.split('\n')) {
        const s = parseSignal(line);
        if (s) onSignal(s);
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
