/**
 * Mã Win32 dùng chung cho hook và extension (nháy taskbar, tìm cửa sổ foreground, tra cây tiến trình).
 * PowerShell biên dịch C# bằng Add-Type mất 1 đến 15 giây mỗi lần (đo 3/10/2026: 94/696 lần nháy quá 5 giây),
 * nên biên dịch một lần ra DLL trong thư mục tạm, tên mang hash của mã nguồn; lần sau chỉ nạp DLL (vài chục ms).
 *
 * Mã C# nằm trong template TS rồi trong here-string PowerShell "@...@": viết \\t, \\u25CF để file .ps1 nhận \t, ●
 * cho C#; không dùng $ hay backtick trong phần C#.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { ProcEntry } from './proctree';

export const NATIVE_SOURCE = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NoIdleNative {
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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder text, uint count);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
  [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

  // FLASHW_ALL | FLASHW_TIMERNOFG: nhay toi khi cua so len foreground.
  const uint FLASH_FLAGS = 15;

  // ---- Cay tien trinh (Toolhelp32, vai ms) ----
  public static Dictionary<uint, uint> Parent = new Dictionary<uint, uint>();
  public static Dictionary<uint, string> Exe = new Dictionary<uint, string>();
  public static void Snapshot() {
    Parent.Clear(); Exe.Clear();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap.ToInt64() == -1) return;
    var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(e);
    if (Process32FirstW(snap, ref e)) {
      do { Parent[e.th32ProcessID] = e.th32ParentProcessID; Exe[e.th32ProcessID] = e.szExeFile.ToLowerInvariant(); } while (Process32NextW(snap, ref e));
    }
    CloseHandle(snap);
  }
  public static string ExeOf(uint pid) { string n; return Exe.TryGetValue(pid, out n) ? n : ""; }
  /** pid roi cha, ong... toi da maxDepth; moi dong "pid<tab>exe". Dung khi het bang hay gap vong. */
  public static string[] Chain(uint pid, int maxDepth) {
    Snapshot();
    var outList = new List<string>();
    var seen = new HashSet<uint>();
    uint cur = pid;
    while (cur != 0 && !seen.Contains(cur) && outList.Count < maxDepth) {
      outList.Add(cur.ToString() + "\\t" + ExeOf(cur));
      seen.Add(cur);
      uint p;
      if (!Parent.TryGetValue(cur, out p)) break;
      cur = p;
    }
    return outList.ToArray();
  }

  // ---- Cua so ----
  public static List<IntPtr> Handles = new List<IntPtr>();
  public static List<uint> Pids = new List<uint>();
  public static List<string> Titles = new List<string>();
  public static bool Collect(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var t = TitleOf(h);
    if (t.Length == 0) return true;
    uint pid; GetWindowThreadProcessId(h, out pid);
    Handles.Add(h); Pids.Add(pid); Titles.Add(t);
    return true;
  }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  public static int FlashHandle(IntPtr h, IntPtr fg) {
    if (h == fg) return 3;
    var f = new FLASHWINFO();
    f.cbSize = (uint)Marshal.SizeOf(f);
    f.hwnd = h; f.dwFlags = FLASH_FLAGS; f.uCount = 0; f.dwTimeout = 0;
    FlashWindowEx(ref f);
    return 0;
  }

  // ---- Extension: nhay cua so VS Code cua minh ----
  /**
   * Tieu de VS Code "file - workspace - [profile -] Visual Studio Code": ten workspace phai la mot doan rieng,
   * va khong phai doan dau khi co tu 3 doan (doan dau la ten file dang mo, co the trung ten workspace khac).
   */
  public static bool TitleMatches(string title, string workspace) {
    var t = title.ToLowerInvariant();
    if (!t.Contains("visual studio code")) return false;
    if (workspace.Length == 0) return true;
    var parts = t.Split(new string[] { " - " }, StringSplitOptions.None);
    int start = parts.Length >= 3 ? 1 : 0;
    for (int i = start; i < parts.Length; i++) {
      var p = parts[i].TrimStart('\\u25CF', '\\u25CB', '\\u2022', '*', ' ').Trim();
      if (p == workspace || p == workspace + " (workspace)") return true;
    }
    return false;
  }
  /** Handle da hoc con dung thi nhay thang; sai thi tim theo ten va cong 10 vao ma. 0 nhay, 2 khong thay, 3 dang foreground. */
  public static int FlashWindow(string workspace, long hwnd) {
    IntPtr fg = GetForegroundWindow();
    int stale = 0;
    if (hwnd != 0) {
      IntPtr known = new IntPtr(hwnd);
      if (IsWindow(known) && IsWindowVisible(known) && TitleMatches(TitleOf(known), workspace)) return FlashHandle(known, fg);
      stale = 10;
    }
    Handles.Clear(); Pids.Clear(); Titles.Clear();
    EnumWindows(Collect, IntPtr.Zero);
    for (int i = 0; i < Titles.Count; i++) {
      if (workspace.Length == 0 || !TitleMatches(Titles[i], workspace)) continue;
      return stale + FlashHandle(Handles[i], fg);
    }
    return stale + 2;
  }
  /** "hwnd<tab>tieu de" cua cua so foreground. */
  public static string Foreground() {
    IntPtr h = GetForegroundWindow();
    return h.ToInt64().ToString() + "\\t" + TitleOf(h);
  }

  // ---- Hook: nhay cua so chua agent (terminal roi) ----
  public static string Chosen = "";
  public static string How = "";
  public static string ConsoleTitle = "";
  static readonly HashSet<string> HostExes = new HashSet<string> { "conhost.exe", "openconsole.exe", "windowsterminal.exe" };
  /**
   * Duyet ca chuoi: hook bi bash/cmd/powershell boc, console cua chung an (khong co cua so hay cua so an) nen phai
   * di tiep toi console cua agent. Pseudo console (conpty) cua Windows Terminal co owner goc la cua so WT; cua VS Code
   * thi owner la chinh no (bo). Conhost co dien tra thang cua so console.
   */
  public static IntPtr ConsoleHost(uint[] chain) {
    foreach (uint p in chain) {
      FreeConsole();
      if (!AttachConsole(p)) continue;
      IntPtr h = GetConsoleWindow();
      if (h == IntPtr.Zero) continue;
      var ct = new StringBuilder(512); GetConsoleTitle(ct, (uint)ct.Capacity);
      IntPtr root = GetAncestor(h, 3);
      if (root != IntPtr.Zero && root != h) {
        if (ConsoleTitle.Length == 0) ConsoleTitle = ct.ToString();
        if (IsWindowVisible(root)) return root;
        continue;
      }
      if (ClassOf(h) == "PseudoConsoleWindow") { if (ConsoleTitle.Length == 0) ConsoleTitle = ct.ToString(); continue; }
      if (IsWindowVisible(h)) { if (ConsoleTitle.Length == 0) ConsoleTitle = ct.ToString(); return h; }
    }
    return IntPtr.Zero;
  }
  /** Cua so cua editor (pid chinh ma extension dang ky, hay tieu de VS Code) thi tra 4 de extension nhay theo ten workspace. */
  public static int FlashHwnd(IntPtr h, IntPtr fg, string title, HashSet<uint> editors) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    Chosen = "pid " + pid + " " + title + " " + How;
    if (editors.Contains(pid) || title.ToLowerInvariant().Contains("visual studio code")) return 4;
    return FlashHandle(h, fg);
  }
  public static int HostFlash(uint[] chain, uint[] editorPids) {
    var editors = new HashSet<uint>(editorPids);
    IntPtr fg = GetForegroundWindow();
    ConsoleTitle = ""; Chosen = ""; How = "";
    IntPtr host = ConsoleHost(chain);
    if (host != IntPtr.Zero) { How = "[console]"; return FlashHwnd(host, fg, TitleOf(host), editors); }
    if (Parent.Count == 0) Snapshot();
    Handles.Clear(); Pids.Clear(); Titles.Clear();
    EnumWindows(Collect, IntPtr.Zero);
    // Mot tien trinh co nhieu cua so (Windows Terminal): uu tien cua so co tieu de trung tieu de console cua agent,
    // khong lay cua so tren cung theo thu tu Z. Cua so cua tien trinh con chi nhan khi con la console host
    // (conhost cua cmd co dien), khong nhan app nguoi dung mo tu terminal (notepad, trinh duyet...).
    foreach (uint p in chain) {
      if (ExeOf(p) == "explorer.exe") continue;
      int first = -1;
      for (int i = 0; i < Handles.Count; i++) {
        uint wp = Pids[i]; uint wpp;
        bool own = wp == p || (Parent.TryGetValue(wp, out wpp) && wpp == p && HostExes.Contains(ExeOf(wp)));
        if (!own) continue;
        if (ExeOf(wp) == "explorer.exe") continue;
        if (ConsoleTitle.Length > 0 && Titles[i] == ConsoleTitle) { How = "[title]"; return FlashHwnd(Handles[i], fg, Titles[i], editors); }
        if (first < 0) first = i;
      }
      if (first >= 0) { How = "[z-order]"; return FlashHwnd(Handles[first], fg, Titles[first], editors); }
    }
    return 2;
  }
}
`;

const HASH = crypto.createHash('sha1').update(NATIVE_SOURCE).digest('hex').slice(0, 10);

export function nativeDir(): string {
  return path.join(os.tmpdir(), 'noidle-tts', 'native');
}

export function nativeDllPath(dir = nativeDir()): string {
  return path.join(dir, `noidle-native-${HASH}.dll`);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Script PowerShell: nạp DLL đã biên dịch; chưa có thì biên dịch ra file tạm rồi đổi tên (hai hook chạy cùng lúc
 * không ghi đè nhau); không ghi được thì Add-Type trong bộ nhớ như cũ. body chạy sau khi [NoIdleNative] sẵn sàng.
 */
export function nativeScript(body: string, dir = nativeDir()): string {
  return `
$ErrorActionPreference = 'Stop'
$dir = ${q(dir)}
$dll = ${q(nativeDllPath(dir))}
$src = @"
${NATIVE_SOURCE}
"@
$loaded = $false
if (-not (Test-Path $dll)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$dll.$PID.tmp"
  try {
    Add-Type -TypeDefinition $src -OutputAssembly $tmp
    Move-Item -Force $tmp $dll -ErrorAction SilentlyContinue
  } catch { }
  Remove-Item $tmp -ErrorAction SilentlyContinue
  if (-not (Test-Path $dll)) { Add-Type -TypeDefinition $src; $loaded = $true }
}
if (-not $loaded) { try { Add-Type -Path $dll } catch { Add-Type -TypeDefinition $src } }
${body}
`;
}

export interface RunResult {
  code: number;
  out: string;
}

/** Ghi script ra file tạm rồi chạy powershell -File; trả exit code và stdout. Quá 15 giây thì giết, code -1. */
export function runPowerShell(script: string, name: string): Promise<RunResult> {
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

/** Đọc các dòng "chain<tab>pid<tab>exe" script in ra (gần nhất trước). */
export function parseChain(out: string): ProcEntry[] {
  const chain: ProcEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^chain\t(\d+)\t(.*)$/.exec(line);
    if (m) chain.push({ pid: Number(m[1]), exe: m[2].trim().toLowerCase() });
  }
  return chain;
}
