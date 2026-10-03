/**
 * Cây tiến trình: hook chạy dưới Claude Code, Claude Code chạy dưới shell của một terminal VS Code.
 * Hook gửi chuỗi pid tổ tiên của Claude kèm tín hiệu; extension so với processId (pid shell) của từng terminal
 * để chọn đúng terminal đang chạy Claude thay vì terminal đang focus.
 */
import { execFile } from 'child_process';
import type { SignalSource } from './signal';

/** Đọc bảng "pid ppid" mỗi dòng (PowerShell hoặc ps); dòng không phải hai số thì bỏ. */
export function parseParentTable(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/** Bảng pid → ppid của cả máy. Lỗi thì bảng rỗng, extension sẽ fallback về terminal đang focus. */
export function parentMap(): Promise<Map<number, number>> {
  const [cmd, args] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
        ]
      : ['ps', ['-eo', 'pid=,ppid=']];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : parseParentTable(String(stdout)));
    });
  });
}

/** pid rồi cha, ông... theo bảng; dừng khi hết bảng, gặp vòng, hay đủ maxDepth. */
export function ancestorsOf(pid: number, map: Map<number, number>, maxDepth = 12): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && !seen.has(cur) && out.length < maxDepth) {
    out.push(cur);
    seen.add(cur);
    cur = map.get(cur);
  }
  return out;
}

export interface TerminalLike {
  name: string;
  processId: Thenable<number | undefined>;
}

/** Terminal có pid shell nằm trong chuỗi tổ tiên; không có thì undefined. */
export async function pickTerminal<T extends TerminalLike>(terminals: readonly T[], ancestors: number[] | undefined): Promise<T | undefined> {
  if (!ancestors?.length || !terminals.length) return undefined;
  const want = new Set(ancestors);
  const pids = await Promise.all(terminals.map((t) => Promise.resolve(t.processId).catch(() => undefined)));
  for (let i = 0; i < terminals.length; i++) {
    const pid = pids[i];
    if (pid !== undefined && want.has(pid)) return terminals[i];
  }
  return undefined;
}

export async function terminalForAgent<T extends TerminalLike>(
  terminals: readonly T[], ancestors: number[] | undefined, active: T | undefined, source?: SignalSource,
): Promise<T | undefined> {
  const matched = await pickTerminal(terminals, ancestors);
  if (matched) return matched;
  // Biết cây tiến trình mà không khớp terminal nào: agent chạy ở terminal ngoài VS Code, không chèn lời nói vào
  // một shell không liên quan. Copilot CLI không bao giờ lùi. Claude chỉ lùi về terminal đang chọn khi hook
  // không tra được cây tiến trình (không biết agent ở đâu), như trước.
  if (source === 'copilot-cli' || ancestors?.length) return undefined;
  return active;
}

/**
 * Cửa sổ này có đang chứa agent không, theo chuỗi pid tổ tiên của hook. Copilot Chat chạy hook bằng child_process
 * ngay trong extension host, nên pid extension host (process.pid của extension) nằm trong chuỗi. Claude Code và
 * Copilot CLI chạy trong một terminal của cửa sổ, nên shell pid của terminal đó nằm trong chuỗi.
 */
export async function agentInWindow<T extends TerminalLike>(ancestors: number[] | undefined, hostPid: number, terminals: readonly T[]): Promise<boolean> {
  if (!ancestors?.length) return false;
  if (ancestors.includes(hostPid)) return true;
  return (await pickTerminal(terminals, ancestors)) !== undefined;
}

/** Một mắt trong chuỗi tiến trình: pid và tên file thực thi (thường, có hoặc không có .exe). */
export interface ProcEntry {
  pid: number;
  exe: string;
}

/**
 * Shell và console host bọc quanh hook: Claude Code chạy hook qua bash.exe -c (hai lớp), Copilot Chat qua powershell,
 * Copilot CLI qua cmd. Pid của chúng đổi mỗi lần gọi nên không dùng làm neo để nhớ chuỗi theo phiên.
 */
const WRAPPER_EXES = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh', 'conhost', 'openconsole']);

export function isWrapperExe(exe: string): boolean {
  return WRAPPER_EXES.has(exe.toLowerCase().replace(/\.exe$/, ''));
}

/** Vị trí của tiến trình agent (pid đầu tiên không phải vỏ bọc); -1 nếu toàn vỏ bọc. */
export function anchorIndex(chain: ProcEntry[]): number {
  return chain.findIndex((e) => !isWrapperExe(e.exe));
}

/** Chuỗi pid từ agent trở lên (bỏ vỏ bọc tạm ở đầu). Không tìm được neo thì trả cả chuỗi. */
export function agentChainFrom(chain: ProcEntry[]): number[] {
  const i = anchorIndex(chain);
  return (i < 0 ? chain : chain.slice(i)).map((e) => e.pid);
}

/** Đọc bảng "pid ppid comm" (ps -eo pid=,ppid=,comm=); dòng không đúng dạng thì bỏ. */
export function parseProcTable(text: string): Map<number, ProcEntry & { ppid: number }> {
  const map = new Map<number, ProcEntry & { ppid: number }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), exe: m[3].toLowerCase() });
  }
  return map;
}

/** Bảng tiến trình POSIX kèm tên lệnh. Windows dùng NoIdleNative.Chain (native.ts). Lỗi thì bảng rỗng. */
export function procTable(): Promise<Map<number, ProcEntry & { ppid: number }>> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : parseProcTable(String(stdout)));
    });
  });
}

/** pid rồi cha, ông... theo bảng; dừng khi hết bảng, gặp vòng, hay đủ maxDepth. */
export function procChain(pid: number, table: Map<number, ProcEntry & { ppid: number }>, maxDepth = 14): ProcEntry[] {
  const out: ProcEntry[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && !seen.has(cur) && out.length < maxDepth) {
    const e = table.get(cur);
    // Cha không có trong bảng (đã chết) thì dừng: pid chết không khớp terminal nào. pid đầu luôn giữ.
    if (!e && out.length) break;
    out.push({ pid: cur, exe: e?.exe ?? '' });
    seen.add(cur);
    cur = e?.ppid;
  }
  return out;
}
