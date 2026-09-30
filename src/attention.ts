/**
 * Làm nổi cửa sổ VS Code của workspace vừa có việc (Claude xong, cần approve, cần trả lời) khi người dùng
 * mở nhiều cửa sổ: nháy nút trên taskbar Windows (FlashWindowEx) cho tới khi cửa sổ đó lên foreground.
 * VS Code không có API cho việc này nên gọi user32 qua PowerShell. macOS dùng blinkTitleBar ở cuối file.
 * Tất cả cửa sổ VS Code chung một tiến trình chính, nên chọn cửa sổ theo tiêu đề: tiêu đề mặc định luôn có
 * tên workspace giữa hai dấu " - " ("hook.ts - vi-voice - Visual Studio Code").
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

/** Tiêu đề là của VS Code và có đúng tên workspace là một đoạn riêng (không phải một phần của tên khác). */
export function windowTitleMatches(title: string, workspaceName: string): boolean {
  const t = title.toLowerCase();
  if (!t.includes('visual studio code')) return false;
  const name = workspaceName.toLowerCase().trim();
  // Multi-root: tiêu đề ghi "tên (Workspace)"; tên truyền vào có thể có hoặc không có hậu tố đó.
  const bare = name.replace(/ \(workspace\)$/, '');
  const parts = t.split(' - ').map((p) => p.replace(/^[●○•*]\s*/, '').trim());
  return parts.some((p) => p === bare || p === `${bare} (workspace)`);
}

const FLASHW_ALL = 3;
const FLASHW_TIMERNOFG = 12;

/** Handle cửa sổ (số thập phân từ script) hợp lệ thì trả về, không thì '0' (script tìm theo tên). */
function hwndArg(hwnd: string | undefined): string {
  return hwnd && /^\d{1,19}$/.test(hwnd) ? hwnd : '0';
}

/**
 * Script PowerShell: nháy cửa sổ VS Code tới khi nó lên foreground. Có handle đã học (xem learnForegroundWindow) và
 * cửa sổ còn đó thì nháy thẳng handle; không thì tìm cửa sổ có tên workspace trong tiêu đề (hai cửa sổ trùng tên
 * thì cách này có thể chọn nhầm). Exit 0 nháy, 2 không thấy, 3 đang ở foreground.
 */
export function flashScript(workspaceName: string, hwnd?: string): string {
  const name = workspaceName.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NoIdleWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
  public static System.Collections.Generic.List<IntPtr> Handles = new System.Collections.Generic.List<IntPtr>();
  public static System.Collections.Generic.List<string> Titles = new System.Collections.Generic.List<string>();
  public static bool Collect(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    var t = sb.ToString();
    if (t.Length > 0) { Handles.Add(h); Titles.Add(t); }
    return true;
  }
  public static int FlashHandle(IntPtr h, IntPtr fg) {
    if (h == fg) return 3;
    var f = new FLASHWINFO();
    f.cbSize = (uint)Marshal.SizeOf(f);
    f.hwnd = h;
    f.dwFlags = ${FLASHW_ALL | FLASHW_TIMERNOFG};
    f.uCount = 0;
    f.dwTimeout = 0;
    FlashWindowEx(ref f);
    return 0;
  }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  public static bool TitleMatches(string title, string workspace) {
    var t = title.ToLowerInvariant();
    if (!t.Contains("visual studio code")) return false;
    if (workspace.Length == 0) return true;
    foreach (var raw in t.Split(new string[] { " - " }, StringSplitOptions.None)) {
      var p = raw.TrimStart('\\u25CF', '\\u25CB', '\\u2022', '*', ' ').Trim();
      if (p == workspace || p == workspace + " (workspace)") return true;
    }
    return false;
  }
  /** Handle đã học phải còn là cửa sổ VS Code mang tên workspace này (học nhầm lúc cửa sổ khác còn ở foreground); sai thì tìm theo tên và cộng 10 vào mã để extension quên handle. */
  public static int Flash(string workspace, long hwnd) {
    IntPtr fg = GetForegroundWindow();
    int stale = 0;
    if (hwnd != 0) {
      IntPtr known = new IntPtr(hwnd);
      if (IsWindow(known) && IsWindowVisible(known) && TitleMatches(TitleOf(known), workspace)) return FlashHandle(known, fg);
      stale = 10;
    }
    Handles.Clear(); Titles.Clear();
    EnumWindows(Collect, IntPtr.Zero);
    for (int i = 0; i < Titles.Count; i++) {
      if (workspace.Length == 0 || !TitleMatches(Titles[i], workspace)) continue;
      return stale + FlashHandle(Handles[i], fg);
    }
    return stale + 2;
  }
}
"@
$ws = '${name}'.ToLowerInvariant() -replace ' \(workspace\)$', ''
exit [NoIdleWin]::Flash($ws, ${hwndArg(hwnd)})
`;
}

/** Script PowerShell: in "hwnd<tab>tiêu đề" của cửa sổ đang ở foreground (handle dạng số thập phân). */
export function foregroundWindowScript(): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NoIdleFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static string Read() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    return h.ToInt64().ToString() + "\`t" + sb.ToString();
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([NoIdleFg]::Read())
`;
}

export interface ForegroundWindow {
  /** Handle dạng số thập phân, đưa lại cho flashScript. */
  hwnd: string;
  title: string;
}

/** Đọc "hwnd<tab>tiêu đề"; chỉ nhận cửa sổ VS Code (extension chỉ học handle khi chính nó đang focus). */
export function parseForegroundWindow(out: string): ForegroundWindow | undefined {
  const m = /^(\d+)\t(.*)$/.exec(out.trim());
  if (!m) return undefined;
  const title = m[2].trim();
  if (!title.toLowerCase().includes('visual studio code')) return undefined;
  return { hwnd: m[1], title };
}

/**
 * Cửa sổ VS Code nào đang ở foreground. Extension gọi lúc cửa sổ của mình vừa được focus để biết handle của chính
 * nó: VS Code không cho extension biết handle, và mọi cửa sổ chung một tiến trình nên không tra theo pid được.
 * Có handle thì nháy đúng cửa sổ dù nhiều cửa sổ trùng tên workspace. undefined ngoài Windows hay khi lỗi.
 */
export async function learnForegroundWindow(deps: FlashDeps = {}): Promise<ForegroundWindow | undefined> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const run = deps.run ?? ((script) => runPowerShell(script, 'foreground'));
  try {
    const r = await run(foregroundWindowScript());
    if (typeof r === 'number' || r.code !== 0) return undefined;
    return parseForegroundWindow(r.out);
  } catch {
    return undefined;
  }
}

export type FlashResult = 'flashed' | 'not-found' | 'foreground' | 'unsupported' | 'error';

export interface FlashDeps {
  platform?: NodeJS.Platform;
  /** Chạy script, trả exit code (kèm stdout nếu có). Mặc định: ghi ra file tạm rồi gọi powershell -File. */
  run?: (script: string) => Promise<number | RunResult>;
  /** flashWindow: handle cửa sổ đã học (learnForegroundWindow); có thì nháy thẳng, không cần tìm theo tên. */
  hwnd?: string;
}

/** Kết quả chạy script: exit code và stdout (script nháy cửa sổ chứa agent in ra cửa sổ đã chọn để ghi log). */
export interface RunResult {
  code: number;
  out: string;
}

async function runPowerShell(script: string, name = 'flash'): Promise<RunResult> {
  const dir = path.join(os.tmpdir(), 'noidle-tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${process.pid}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out });
    }, 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, out });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

function codeOf(r: number | RunResult): number {
  return typeof r === 'number' ? r : r.code;
}

export interface FlashOutcome {
  result: FlashResult;
  /** Handle đã học không còn là cửa sổ của workspace này: script đã tìm theo tên, extension nên quên handle và học lại. */
  staleHandle: boolean;
}

/** Nháy nút taskbar của cửa sổ VS Code theo handle đã học, không có thì theo tên workspace. Không ném lỗi; kết quả để ghi log. */
export async function flashWindowEx(workspaceName: string, deps: FlashDeps = {}): Promise<FlashOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return { result: 'unsupported', staleHandle: false };
  const run = deps.run ?? runPowerShell;
  let code: number;
  try {
    code = codeOf(await run(flashScript(workspaceName, deps.hwnd)));
  } catch {
    return { result: 'error', staleHandle: false };
  }
  const staleHandle = code >= 10 && code <= 13;
  const base = staleHandle ? code - 10 : code;
  const result: FlashResult = base === 0 ? 'flashed' : base === 2 ? 'not-found' : base === 3 ? 'foreground' : 'error';
  return { result, staleHandle };
}

export async function flashWindow(workspaceName: string, deps: FlashDeps = {}): Promise<FlashResult> {
  return (await flashWindowEx(workspaceName, deps)).result;
}

/**
 * Có nhận handle vừa đọc làm handle của cửa sổ mình không. Cửa sổ mới mở: extension đã "focused" nhưng OS có thể còn
 * để cửa sổ cũ ở foreground, nên tiêu đề đọc được phải mang tên workspace này (biết tên). Hai cửa sổ trùng tên thì
 * tên không phân biệt được, còn lại dựa vào focus: mất focus trong lúc đọc thì bỏ, học lại lần focus sau.
 */
export function acceptLearnedWindow(w: ForegroundWindow, workspaceName: string, stillFocused: boolean): boolean {
  if (!stillFocused) return false;
  if (!workspaceName) return true;
  return windowTitleMatches(w.title, workspaceName);
}

/**
 * Agent chạy ở terminal rời (Windows Terminal, cmd, PowerShell): không có extension nào để nháy hộ, hook tự nháy
 * cửa sổ đang chứa tiến trình agent. Hook là con của agent nên chuỗi pid tổ tiên (gần nhất trước) là của nó.
 *
 * Bước 1, theo console: gắn vào console của một pid trong chuỗi (AttachConsole; hook có thể bị spawn không có
 * console) rồi lấy GetConsoleWindow. Windows Terminal (kể cả khi Win11 giao cmd/PowerShell mở rời cho nó qua
 * "default terminal", lúc đó WT không nằm trong cây tiến trình) trả một PseudoConsoleWindow ẩn mà owner gốc
 * (GetAncestor GA_ROOTOWNER) là cửa sổ WT. Conhost cổ điển trả thẳng cửa sổ console. Conpty của VS Code thì
 * owner gốc là chính nó, không có gì để nháy ở bước này.
 *
 * Bước 2, theo cây tiến trình (Toolhelp32, vài ms): duyệt chuỗi, lấy cửa sổ hiện của pid đó hoặc của con nó.
 * Cửa sổ là VS Code thì không nháy ở đây mà trả 4: mọi cửa sổ VS Code chung một pid, extension chọn theo tên
 * workspace. explorer.exe (desktop, File Explorer) bị bỏ qua để không nháy nhầm khi nó nằm trong chuỗi.
 * Exit 0 nháy, 2 không thấy, 3 đang ở foreground, 4 là VS Code.
 */
export function flashHostScript(pids: number[]): string {
  const list = pids.filter((p) => Number.isSafeInteger(p) && p > 0).join(', ');
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NoIdleHost {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32W {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
    public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
  [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static List<IntPtr> Handles = new List<IntPtr>();
  public static List<uint> Pids = new List<uint>();
  public static List<string> Titles = new List<string>();
  public static bool Collect(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    var t = sb.ToString();
    if (t.Length == 0) return true;
    uint pid; GetWindowThreadProcessId(h, out pid);
    Handles.Add(h); Pids.Add(pid); Titles.Add(t);
    return true;
  }
  public static string Chosen = "";
  public static int FlashHwnd(IntPtr h, IntPtr fg, string title) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    Chosen = "pid " + pid + " " + title;
    if (title.ToLowerInvariant().Contains("visual studio code")) return 4;
    if (h == fg) return 3;
    var f = new FLASHWINFO();
    f.cbSize = (uint)Marshal.SizeOf(f);
    f.hwnd = h;
    f.dwFlags = ${FLASHW_ALL | FLASHW_TIMERNOFG};
    f.uCount = 0;
    f.dwTimeout = 0;
    FlashWindowEx(ref f);
    return 0;
  }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  /** Cửa sổ terminal đang chứa console của một pid trong chuỗi; IntPtr.Zero nếu console không có cửa sổ hiện (conpty của VS Code). */
  public static IntPtr ConsoleHost(uint[] chain) {
    FreeConsole();
    bool attached = false;
    foreach (uint p in chain) { if (AttachConsole(p)) { attached = true; break; } }
    if (!attached) return IntPtr.Zero;
    IntPtr h = GetConsoleWindow();
    if (h == IntPtr.Zero) return IntPtr.Zero;
    IntPtr root = GetAncestor(h, 3);
    if (root != IntPtr.Zero && root != h) return IsWindowVisible(root) ? root : IntPtr.Zero;
    var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
    if (cls.ToString() == "PseudoConsoleWindow") return IntPtr.Zero;
    return IsWindowVisible(h) ? h : IntPtr.Zero;
  }
  public static int Flash(uint[] chain) {
    IntPtr fg = GetForegroundWindow();
    IntPtr host = ConsoleHost(chain);
    if (host != IntPtr.Zero) return FlashHwnd(host, fg, TitleOf(host));
    var parent = new Dictionary<uint, uint>();
    var exe = new Dictionary<uint, string>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap != IntPtr.Zero && snap.ToInt64() != -1) {
      var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(e);
      if (Process32FirstW(snap, ref e)) {
        do { parent[e.th32ProcessID] = e.th32ParentProcessID; exe[e.th32ProcessID] = e.szExeFile.ToLowerInvariant(); } while (Process32NextW(snap, ref e));
      }
      CloseHandle(snap);
    }
    Handles.Clear(); Pids.Clear(); Titles.Clear();
    EnumWindows(Collect, IntPtr.Zero);
    foreach (uint p in chain) {
      string name; if (exe.TryGetValue(p, out name) && name == "explorer.exe") continue;
      for (int i = 0; i < Handles.Count; i++) {
        uint wp = Pids[i]; uint wpp;
        bool own = wp == p || (parent.TryGetValue(wp, out wpp) && wpp == p);
        if (own) return FlashHwnd(Handles[i], fg, Titles[i]);
      }
    }
    return 2;
  }
}
"@
$code = [NoIdleHost]::Flash([uint32[]]@(${list}))
[Console]::Out.Write([NoIdleHost]::Chosen)
exit $code
`;
}

export type HostFlashResult = FlashResult | 'vscode';

export interface HostFlash {
  result: HostFlashResult;
  /** Cửa sổ script đã chọn ("pid N tiêu đề"), để ghi log; rỗng nếu không chọn được. */
  window: string;
}

/** Nháy cửa sổ chứa agent theo chuỗi pid tổ tiên (gần nhất trước). 'vscode': để extension nháy theo tên workspace. */
export async function flashHostWindow(pids: number[], deps: FlashDeps = {}): Promise<HostFlash> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return { result: 'unsupported', window: '' };
  const chain = pids.filter((p) => Number.isSafeInteger(p) && p > 0);
  if (!chain.length) return { result: 'not-found', window: '' };
  const run = deps.run ?? ((script) => runPowerShell(script, 'flash-host'));
  let r: number | RunResult;
  try {
    r = await run(flashHostScript(chain));
  } catch {
    return { result: 'error', window: '' };
  }
  const code = codeOf(r);
  const window = typeof r === 'number' ? '' : r.out.trim();
  const result: HostFlashResult =
    code === 0 ? 'flashed' : code === 2 ? 'not-found' : code === 3 ? 'foreground' : code === 4 ? 'vscode' : 'error';
  return { result, window };
}

/**
 * Tô màu title bar của cửa sổ đang cần người dùng. VS Code không có API đổi màu khung theo cửa sổ, chỉ có
 * workbench.colorCustomizations ở mức workspace (cách Peacock dùng), nên extension ghi vào đó rồi trả lại khi xong.
 */
export const TINT = {
  /** Mặc định xanh lá, người dùng chọn 24/9/2026; người dùng đổi bằng noIdle.attentionTintColor. */
  activeBackground: '#15803d',
  inactiveBackground: '#15803d',
  foreground: '#ffffff',
};

export type ColorMap = Record<string, string>;

/** "#rgb" hoặc "#rrggbb" thành "#rrggbb" thường; không hợp lệ thì trả fallback. */
export function normalizeHex(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return fallback;
}

/** Chữ trắng hay tối tuỳ độ sáng của nền (WCAG relative luminance). */
export function tintForeground(bg: string): string {
  const hex = normalizeHex(bg, TINT.activeBackground);
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  return lum > 0.4 ? '#1f1a00' : '#ffffff';
}

function tintKeys(bg: string): ColorMap {
  const fg = tintForeground(bg);
  return {
    'titleBar.activeBackground': bg,
    'titleBar.inactiveBackground': bg,
    'titleBar.activeForeground': fg,
    'titleBar.inactiveForeground': fg,
  };
}

/**
 * VS Code mới vẽ editor, panel, sidebar như các ô nổi trên nền chrome, và nền đó mặc định lấy màu title bar
 * (CSS: modernUI.shellBackground rơi về titleBar.activeBackground). Chỉ tô title bar thì cả viền quanh các phần
 * cũng cam; đặt nền chrome bằng màu gốc của theme thì chỉ còn thanh trên đổi màu.
 */
/** Nền chrome lúc cửa sổ active và inactive; khoá inactive mặc định theo titleBar.inactiveBackground. */
const SHELL_KEYS = ['modernUI.shellBackground', 'modernUI.inactiveShellBackground'];

/** Màu nền chrome gốc theo loại theme (Dark Modern #181818, Light Modern #f8f8f8); theme khác lệch chút cũng chỉ trong lúc tô. */
export function shellColorFor(kind: 'dark' | 'light' | 'hcDark' | 'hcLight'): string {
  return { dark: '#181818', light: '#f8f8f8', hcDark: '#000000', hcLight: '#ffffff' }[kind];
}

/** Thêm màu title bar vào bảng màu hiện có; saved giữ giá trị cũ của đúng các khoá bị ghi đè để trả lại. */
export function applyTint(current: ColorMap | undefined, shell: string, bg = TINT.activeBackground): { next: ColorMap; saved: ColorMap } {
  const next: ColorMap = { ...(current ?? {}) };
  const saved: ColorMap = {};
  for (const [k, v] of Object.entries(tintKeys(bg))) {
    if (typeof next[k] === 'string') saved[k] = next[k];
    next[k] = v;
  }
  for (const k of SHELL_KEYS) if (typeof next[k] !== 'string') next[k] = shell;
  return { next, saved };
}

/** Bỏ màu đã tô: trả giá trị cũ, xoá khoá mình thêm; khoá người dùng đã tự đổi trong lúc đó thì giữ. Rỗng thì undefined. */
export function removeTint(current: ColorMap | undefined, saved: ColorMap, shell: string, bg = TINT.activeBackground): ColorMap | undefined {
  const next: ColorMap = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(tintKeys(bg))) {
    if (next[k] !== v) continue;
    if (k in saved) next[k] = saved[k];
    else delete next[k];
  }
  for (const k of SHELL_KEYS) if (next[k] === shell && !(k in saved)) delete next[k];
  return Object.keys(next).length ? next : undefined;
}

/** Số lần nháy title bar và nhịp mỗi nửa chu kỳ (ms), gần giống nhịp nháy taskbar của Windows. */
export const BLINK = { times: 4, halfMs: 450 };

export interface BlinkDeps {
  /** Tô màu title bar. */
  on(): Promise<void>;
  /** Gỡ màu title bar. */
  off(): Promise<void>;
  wait(ms: number): Promise<void>;
  /** true khi không cần nháy nữa (người dùng đã quay về cửa sổ). */
  cancelled(): boolean;
}

/**
 * macOS không có taskbar và không cho tiến trình khác làm nảy icon VS Code trên Dock, nên thay bằng nháy
 * title bar: tắt bật màu vài lần rồi giữ màu (hold) hoặc gỡ hẳn. Bị huỷ giữa chừng thì gỡ màu và dừng.
 */
export async function blinkTitleBar(deps: BlinkDeps, hold: boolean, opts = BLINK): Promise<'done' | 'cancelled'> {
  for (let i = 0; i < opts.times; i++) {
    await deps.off();
    await deps.wait(opts.halfMs);
    if (deps.cancelled()) return 'cancelled';
    await deps.on();
    if (deps.cancelled()) {
      await deps.off();
      return 'cancelled';
    }
    await deps.wait(opts.halfMs);
    if (deps.cancelled()) {
      await deps.off();
      return 'cancelled';
    }
  }
  if (!hold) await deps.off();
  return 'done';
}
