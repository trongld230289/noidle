# Flash Routing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The taskbar flash (and every other hook → extension signal) reaches the window that actually hosts the agent, within about one second, for Claude Code, Copilot Chat and Copilot CLI, in VS Code terminals and in standalone terminals.

**Architecture:** One precompiled C# helper (`NoIdleNative`, cached as a DLL under `%TEMP%\noidle-tts\native`) replaces the per-call `Add-Type` compile and the 5 to 15 s `Get-CimInstance` process-table query. The hook climbs its own process chain with Toolhelp32 inside that helper, caches the chain per session anchored on the first non-shell ancestor (the agent process), and routes every signal by asking windows "do you own this chain?" (probe) before sending. The host-flash script iterates the whole chain for a console with a visible owner and only accepts child windows that belong to console hosts; editor windows are recognised by the main-process pid each extension registers, not by title text.

**Tech Stack:** TypeScript (esbuild bundles `src/hook.ts` and `src/extension.ts`), vitest, PowerShell 5.1 + C# via `Add-Type`, Win32 (user32/kernel32).

**Spec:** The review in this conversation (2026-10-03), summarised in `C:\Users\Admin\.claude\projects\D--Project-vi-voice\memory\flash-routing-review-2026-10-03.md`.

## Global Constraints

- No version bump; the version only changes at publish time (`feedback-no-version-bump-per-fix`).
- No client project names in src, tests or docs; use `acme` placeholders.
- Vietnamese comments in `src/` follow the existing style; test names may be Vietnamese or English, matching the file they live in.
- Tests must never flash a real window: `vitest.config.ts` sets `VI_VOICE_HOST_FLASH=0`; keep honouring it.
- The hook bundle must stay self-contained (`esbuild --bundle`), so no new runtime dependencies.
- Windows-only native code must degrade to the existing `ps`-based path on macOS/Linux.

## Review Focus

1. **Hook spawned through two shell wrappers (bash → bash → node).** The cached chain must anchor on the agent process, never on the wrapper pid. Test: Task 5 spawns the hook through `cmd.exe /c` (or `sh -c`) twice and expects the second run to log `proctree: dùng lại`.
2. **Two windows with the same or nested folder, agent in the window whose folder is the shorter prefix.** listen/ask/submitted/chatPending must reach the owner, not the longest-prefix window. Test: Task 4 `routeSignal` probe test with parent/child folders for a `listen` signal.
3. **Chain known, no window owns it (agent in a standalone terminal that could not be flashed).** attention must not fall back to the cwd window. Test: Task 4 "không cửa sổ nào nhận" expects no fallback send when `cwdFallback` is false.
4. **Late attention after the user already visited the window.** Test: Task 3 `shouldFlash` returns false when `lastBlurAt >= startedAt`.
5. **A file named like another workspace is the active editor.** Title matching must ignore the editor segment. Test: Task 3 `windowTitleMatches('Research - vi-voice - Visual Studio Code', 'Research')` is false.

---

### Task 1: `src/native.ts` — precompiled Win32 helper and chain parsing

**Files:**
- Create: `src/native.ts`
- Test: `test/native.test.ts`

**Interfaces:**
- Produces: `NATIVE_SOURCE: string` (C#), `nativeDllPath(dir?: string): string`, `nativeScript(body: string, dir?: string): string`, `runPowerShell(script: string, name: string): Promise<RunResult>`, `parseChain(out: string): ProcEntry[]`, `type RunResult = { code: number; out: string }`.
- Consumes: `ProcEntry` from Task 2 (`{ pid: number; exe: string }`). Define it in `src/proctree.ts` first (Task 2 step 1 can be done before this task; the two tasks only share the type).

- [ ] **Step 1: Write the failing test**

```ts
// test/native.test.ts
import { describe, it, expect } from 'vitest';
import { NATIVE_SOURCE, nativeDllPath, nativeScript, parseChain, runPowerShell } from '../src/native';

describe('native: helper C# biên dịch một lần thành DLL', () => {
  it('tên DLL mang hash của mã nguồn, đổi mã là đổi tên', () => {
    const p = nativeDllPath('C:/t');
    expect(p).toMatch(/noidle-native-[0-9a-f]{10}\.dll$/);
    expect(nativeDllPath('C:/t')).toBe(p);
  });
  it('script nạp DLL nếu có, không thì biên dịch ra file tạm rồi đổi tên, lỗi thì Add-Type trong bộ nhớ', () => {
    const s = nativeScript('exit 0', 'C:/t');
    expect(s).toContain('Add-Type -Path');
    expect(s).toContain('-OutputAssembly');
    expect(s).toContain('Move-Item');
    expect(s).toContain('Add-Type -TypeDefinition $src');
    expect(s).toContain(NATIVE_SOURCE.slice(0, 40));
    expect(s.trim().endsWith('exit 0')).toBe(true);
  });
  it('mã C# có đủ các hàm hook và extension cần', () => {
    for (const fn of ['Chain(', 'HostFlash(', 'FlashWindow(', 'Foreground(', 'TitleMatches(']) expect(NATIVE_SOURCE).toContain(fn);
  });
  it('parseChain đọc các dòng "chain<tab>pid<tab>exe", bỏ dòng khác', () => {
    expect(parseChain('chain\t12\tbash.exe\r\nchain\t34\tclaude.exe\nchosen\tpid 1 x\n')).toEqual([
      { pid: 12, exe: 'bash.exe' },
      { pid: 34, exe: 'claude.exe' },
    ]);
    expect(parseChain('')).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('native (thật, Windows)', () => {
  it('Chain từ pid của test trả về chính nó rồi cha của nó', async () => {
    const r = await runPowerShell(nativeScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[NoIdleNative]::Chain(${process.pid}, 6) | ForEach-Object { [Console]::Out.WriteLine("chain\`t" + $_) }
exit 0`), 'test-chain');
    expect(r.code).toBe(0);
    const chain = parseChain(r.out);
    expect(chain[0]?.pid).toBe(process.pid);
    expect(chain[1]?.pid).toBe(process.ppid);
    expect(chain[0]?.exe.toLowerCase()).toBe('node.exe');
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/native.test.ts`
Expected: FAIL, cannot resolve `../src/native`.

- [ ] **Step 3: Write `src/native.ts`**

```ts
/**
 * Mã Win32 dùng chung cho hook và extension (nháy taskbar, tìm cửa sổ foreground, tra cây tiến trình).
 * PowerShell biên dịch C# bằng Add-Type mất 1 đến 15 giây mỗi lần (đo 3/10/2026: 94/696 lần nháy quá 5 giây),
 * nên biên dịch một lần ra DLL trong thư mục tạm, tên mang hash của mã nguồn; lần sau chỉ nạp DLL (vài chục ms).
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
```

Note the C# lives inside a TS template literal **and** a PowerShell double-quoted here-string: write `\\t` and `\\u25CF` in TS so the PowerShell file receives `\t` / `\u25CF`, which C# then interprets. Never put `$` or a backtick in the C# text.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/native.test.ts`
Expected: PASS (the live Windows test compiles the DLL on first run, a few seconds; the second run loads it).

- [ ] **Step 5: Commit**

```bash
git add src/native.ts test/native.test.ts
git commit -m "feat: precompiled Win32 helper with process chain, replacing per-call Add-Type"
```

---

### Task 2: `src/proctree.ts` — chain entries, agent anchor, POSIX table with exe names

**Files:**
- Modify: `src/proctree.ts`
- Test: `test/proctree.test.ts`

**Interfaces:**
- Produces: `interface ProcEntry { pid: number; exe: string }`, `isWrapperExe(exe: string): boolean`, `anchorIndex(chain: ProcEntry[]): number`, `agentChainFrom(chain: ProcEntry[]): number[]`, `parseProcTable(text: string): Map<number, ProcEntry & { ppid: number }>`, `procTable(): Promise<Map<number, ProcEntry & { ppid: number }>>` (POSIX only; Windows uses Task 1), `procChain(pid, table, maxDepth?): ProcEntry[]`.
- Keeps: `parseParentTable`, `parentMap`, `ancestorsOf`, `pickTerminal`, `terminalForAgent`, `agentInWindow` unchanged.

- [ ] **Step 1: Write the failing tests** (append to `test/proctree.test.ts`)

```ts
import { anchorIndex, agentChainFrom, isWrapperExe, parseProcTable, procChain, type ProcEntry } from '../src/proctree';

describe('neo của chuỗi pid: tiến trình agent, bỏ các shell bọc hook', () => {
  // 3/10/2026: Claude Code chạy hook qua bash.exe -c → bash.exe → node; ppid của hook là bash tạm, mỗi lần một pid khác.
  const chain: ProcEntry[] = [
    { pid: 1, exe: 'bash.exe' }, { pid: 2, exe: 'bash.exe' }, { pid: 3, exe: 'claude.exe' },
    { pid: 4, exe: 'powershell.exe' }, { pid: 5, exe: 'code.exe' }, { pid: 6, exe: 'code.exe' }, { pid: 7, exe: 'explorer.exe' },
  ];
  it('shell và conhost là vỏ bọc, kể cả tên không có .exe (macOS)', () => {
    for (const e of ['bash.exe', 'sh', 'zsh', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'BASH.EXE']) expect(isWrapperExe(e)).toBe(true);
    for (const e of ['claude.exe', 'node.exe', 'code.exe', 'copilot', 'node']) expect(isWrapperExe(e)).toBe(false);
  });
  it('neo là pid đầu tiên không phải vỏ bọc; chuỗi từ neo trở lên là chuỗi của agent', () => {
    expect(anchorIndex(chain)).toBe(2);
    expect(agentChainFrom(chain)).toEqual([3, 4, 5, 6, 7]);
  });
  it('Copilot Chat: hook ← powershell ← extension host; neo là extension host', () => {
    const chat: ProcEntry[] = [{ pid: 10, exe: 'powershell.exe' }, { pid: 11, exe: 'code.exe' }, { pid: 12, exe: 'code.exe' }];
    expect(agentChainFrom(chat)).toEqual([11, 12]);
  });
  it('toàn vỏ bọc hay rỗng thì giữ nguyên chuỗi (không biết neo, còn hơn mất)', () => {
    expect(agentChainFrom([{ pid: 1, exe: 'bash.exe' }])).toEqual([1]);
    expect(agentChainFrom([])).toEqual([]);
  });
});

describe('bảng tiến trình POSIX "pid ppid comm"', () => {
  it('đọc ba cột, bỏ dòng rác; procChain trả pid rồi cha với tên lệnh', () => {
    const t = parseProcTable(' 100 90 node\n90 80 sh\n80 1 zsh\nPID PPID COMM\n');
    expect(t.get(100)).toEqual({ pid: 100, ppid: 90, exe: 'node' });
    expect(procChain(100, t)).toEqual([{ pid: 100, exe: 'node' }, { pid: 90, exe: 'sh' }, { pid: 80, exe: 'zsh' }]);
    expect(procChain(100, t, 2)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/proctree.test.ts`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement** (append to `src/proctree.ts`)

```ts
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
    out.push({ pid: cur, exe: e?.exe ?? '' });
    seen.add(cur);
    cur = e?.ppid;
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/proctree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proctree.ts test/proctree.test.ts
git commit -m "feat: anchor the agent chain on the first non-shell ancestor"
```

---

### Task 3: `src/attention.ts` — scripts on the native helper, chain output, title rule, freshness guard

**Files:**
- Modify: `src/attention.ts` (replace `flashScript`, `foregroundWindowScript`, `flashHostScript`, `flashHostWindow`, `windowTitleMatches`; delete the private `runPowerShell`/`RunResult`; add `shouldFlash`)
- Test: `test/attention.test.ts`

**Interfaces:**
- Consumes: `nativeScript`, `runPowerShell`, `parseChain`, `RunResult` from `./native`; `ProcEntry` from `./proctree`.
- Produces: `flashHostScript(startPid: number, editorPids: number[]): string`; `flashHostWindow(startPid: number, deps?: FlashDeps & { editorPids?: number[] }): Promise<HostFlash>` where `HostFlash = { result: HostFlashResult; window: string; chain: ProcEntry[] }`; `shouldFlash(w: { focused: boolean; lastBlurAt: number; startedAt?: number }): boolean`; `export type { RunResult }` re-exported for existing imports.

- [ ] **Step 1: Update tests** (edit `test/attention.test.ts`)

Replace the `flashHostScript([1234, 88, 7])` expectations and the host-window describe with:

```ts
describe('attention: nháy cửa sổ chứa agent theo chuỗi pid (terminal rời)', () => {
  it('script tự tra chuỗi pid từ pid cho sẵn, nhận danh sách pid editor, in chuỗi và cửa sổ đã chọn', () => {
    const s = flashHostScript(1234, [11384, 2000]);
    expect(s).toContain('[NoIdleNative]::Chain(1234, 14)');
    expect(s).toContain('[uint32[]]@(11384, 2000)');
    expect(s).toContain('HostFlash(');
    expect(s).toContain('"chain`t"');
    expect(s).toContain('"chosen`t"');
    expect(flashHostScript(1, [])).toContain('[uint32[]]@()');
  });
  it('ngoài Windows là unsupported, pid 0 là not-found; cả hai không chạy gì', async () => {
    let spawned = 0;
    const run = async () => { spawned++; return 0; };
    expect((await flashHostWindow(1, { platform: 'linux', run })).result).toBe('unsupported');
    expect((await flashHostWindow(0, { platform: 'win32', run })).result).toBe('not-found');
    expect(spawned).toBe(0);
  });
  it('Windows: exit 0 flashed, 2 not-found, 3 foreground, 4 vscode (để extension nháy theo tên workspace)', async () => {
    const run = (code: number) => async () => code;
    const result = async (code: number) => (await flashHostWindow(1, { platform: 'win32', run: run(code) })).result;
    expect(await result(0)).toBe('flashed');
    expect(await result(2)).toBe('not-found');
    expect(await result(3)).toBe('foreground');
    expect(await result(4)).toBe('vscode');
    expect(await result(-1)).toBe('error');
  });
  it('script in ra chuỗi pid (gần nhất trước) và cửa sổ đã chọn để hook dùng và ghi log', async () => {
    const run = async () => ({ code: 0, out: 'chain\t12\tbash.exe\r\nchain\t34\tclaude.exe\r\nchosen\tpid 31388 Web gallery [console]\r\n' });
    expect(await flashHostWindow(1, { platform: 'win32', run })).toEqual({
      result: 'flashed',
      window: 'pid 31388 Web gallery [console]',
      chain: [{ pid: 12, exe: 'bash.exe' }, { pid: 34, exe: 'claude.exe' }],
    });
  });
});

describe('attention: mã C# chọn cửa sổ chứa agent', () => {
  it('bước console duyệt hết chuỗi (console ẩn của bash/powershell bọc hook không được dừng vòng lặp)', () => {
    // 3/10/2026: vòng lặp cũ dừng ở console đầu tiên attach được = conhost ẩn của bash wrapper, không bao giờ tới WT.
    expect(NATIVE_SOURCE).toMatch(/if \(h == IntPtr\.Zero\) continue;/);
    expect(NATIVE_SOURCE).toContain('"PseudoConsoleWindow") {');
  });
  it('bước cây tiến trình chỉ nhận cửa sổ của con khi con là console host, không nhận app mở từ terminal', () => {
    expect(NATIVE_SOURCE).toContain('HostExes.Contains(ExeOf(wp))');
    expect(NATIVE_SOURCE).toContain('"conhost.exe", "openconsole.exe", "windowsterminal.exe"');
  });
  it('cửa sổ của pid editor đã đăng ký là editor dù tiêu đề không có "Visual Studio Code" (Cursor, VSCodium)', () => {
    expect(NATIVE_SOURCE).toContain('editors.Contains(pid) ||');
  });
});

describe('attention: bỏ nháy khi người dùng đã xem', () => {
  it('shouldFlash: nháy khi cửa sổ không focus và chưa được focus lại từ lúc hook bắt đầu', () => {
    expect(shouldFlash({ focused: true, lastBlurAt: 0, startedAt: 1000 })).toBe(false);
    expect(shouldFlash({ focused: false, lastBlurAt: 0, startedAt: 1000 })).toBe(true);
    // Người dùng còn ở cửa sổ lúc agent xong (rời sau đó): đã thấy, không nháy.
    expect(shouldFlash({ focused: false, lastBlurAt: 1500, startedAt: 1000 })).toBe(false);
    // Rời trước khi agent xong: chưa thấy, nháy.
    expect(shouldFlash({ focused: false, lastBlurAt: 900, startedAt: 1000 })).toBe(true);
    // Hook cũ không gửi giờ: giữ hành vi cũ.
    expect(shouldFlash({ focused: false, lastBlurAt: 1500 })).toBe(true);
  });
});
```

Add to the title tests:

```ts
  it('tên workspace ở đoạn đầu (tên file đang mở) không tính khi tiêu đề có từ 3 đoạn', () => {
    expect(windowTitleMatches('Research - vi-voice - Visual Studio Code', 'Research')).toBe(false);
    expect(windowTitleMatches('Research - Visual Studio Code', 'Research')).toBe(true);
    expect(windowTitleMatches('a.ts - Research - Default - Visual Studio Code', 'Research')).toBe(true);
  });
```

Update the `flashScript`/`foregroundWindowScript` tests to assert on the native body instead of raw P/Invoke text:

```ts
  it('gọi FlashWindow của helper với tên workspace đã escape và hwnd', () => {
    const s = flashScript("it's - acme", '4242');
    expect(s).toContain("'it''s - acme'");
    expect(s).toContain('[NoIdleNative]::FlashWindow($ws, 4242)');
    expect(flashScript('x')).toContain('FlashWindow($ws, 0)');
    expect(flashScript('x', 'abc')).toContain('FlashWindow($ws, 0)');
  });
  it('script lấy cửa sổ foreground qua helper', () => {
    expect(foregroundWindowScript()).toContain('[NoIdleNative]::Foreground()');
  });
```

Import `NATIVE_SOURCE` from `../src/native` and `shouldFlash` from `../src/attention` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/attention.test.ts`
Expected: FAIL (old script text, missing `shouldFlash`, `flashHostWindow` signature).

- [ ] **Step 3: Implement in `src/attention.ts`**

Replace the imports and the three script builders plus `runPowerShell`, `RunResult`, `flashHostWindow`:

```ts
import { spawn } from 'child_process'; // xoá nếu không còn dùng
import { nativeScript, runPowerShell, parseChain, type RunResult } from './native';
import type { ProcEntry } from './proctree';
export type { RunResult } from './native';

export function windowTitleMatches(title: string, workspaceName: string): boolean {
  const t = title.toLowerCase();
  if (!t.includes('visual studio code')) return false;
  const name = workspaceName.toLowerCase().trim();
  const bare = name.replace(/ \(workspace\)$/, '');
  const parts = t.split(' - ').map((p) => p.replace(/^[●○•*]\s*/, '').trim());
  // "file - workspace - [profile -] Visual Studio Code": đoạn đầu là tên file đang mở, có thể trùng tên workspace khác.
  const candidates = parts.length >= 3 ? parts.slice(1) : parts;
  return candidates.some((p) => p === bare || p === `${bare} (workspace)`);
}

function hwndArg(hwnd: string | undefined): string {
  return hwnd && /^\d{1,19}$/.test(hwnd) ? hwnd : '0';
}

/** Nháy cửa sổ VS Code theo handle đã học, không thì theo tên workspace. Exit 0 nháy, 2 không thấy, 3 foreground; +10 nếu handle cũ. */
export function flashScript(workspaceName: string, hwnd?: string): string {
  const name = workspaceName.replace(/'/g, "''");
  return nativeScript(`
$ws = '${name}'.ToLowerInvariant() -replace ' \\(workspace\\)$', ''
exit [NoIdleNative]::FlashWindow($ws, ${hwndArg(hwnd)})`);
}

/** In "hwnd<tab>tiêu đề" của cửa sổ foreground. */
export function foregroundWindowScript(): string {
  return nativeScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([NoIdleNative]::Foreground())`);
}

/**
 * Nháy cửa sổ chứa agent khi agent chạy ở terminal rời. Script tự tra chuỗi pid từ startPid (cha của hook) bằng
 * Toolhelp32 rồi in chuỗi ra để hook dùng lại (không cần tra bảng tiến trình riêng). editorPids: pid tiến trình
 * chính của các editor đang mở (extension đăng ký), cửa sổ của chúng trả 4 để extension nháy theo tên workspace.
 * Exit 0 nháy, 2 không thấy, 3 đang ở foreground, 4 là editor.
 */
export function flashHostScript(startPid: number, editorPids: number[]): string {
  const editors = editorPids.filter((p) => Number.isSafeInteger(p) && p > 0).join(', ');
  return nativeScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$chain = @([NoIdleNative]::Chain(${startPid}, 14))
$pids = [uint32[]]@($chain | ForEach-Object { [uint32](($_ -split "\`t")[0]) })
$code = [NoIdleNative]::HostFlash($pids, [uint32[]]@(${editors}))
$chain | ForEach-Object { [Console]::Out.WriteLine("chain\`t" + $_) }
[Console]::Out.WriteLine("chosen\`t" + [NoIdleNative]::Chosen)
exit $code`);
}

export type HostFlashResult = FlashResult | 'vscode';

export interface HostFlash {
  result: HostFlashResult;
  /** Cửa sổ script đã chọn ("pid N tiêu đề [cách chọn]"), để ghi log; rỗng nếu không chọn được. */
  window: string;
  /** Chuỗi tiến trình từ startPid lên, gần nhất trước; rỗng nếu script không chạy. */
  chain: ProcEntry[];
}

function parseChosen(out: string): string {
  const m = /^chosen\t(.*)$/m.exec(out);
  return m ? m[1].trim() : '';
}

export async function flashHostWindow(startPid: number, deps: FlashDeps & { editorPids?: number[] } = {}): Promise<HostFlash> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return { result: 'unsupported', window: '', chain: [] };
  if (!Number.isSafeInteger(startPid) || startPid <= 0) return { result: 'not-found', window: '', chain: [] };
  const run = deps.run ?? ((script) => runPowerShell(script, 'flash-host'));
  let r: number | RunResult;
  try {
    r = await run(flashHostScript(startPid, deps.editorPids ?? []));
  } catch {
    return { result: 'error', window: '', chain: [] };
  }
  const code = codeOf(r);
  const out = typeof r === 'number' ? '' : r.out;
  const result: HostFlashResult =
    code === 0 ? 'flashed' : code === 2 ? 'not-found' : code === 3 ? 'foreground' : code === 4 ? 'vscode' : 'error';
  return { result, window: parseChosen(out), chain: parseChain(out) };
}

/**
 * Có nên nháy không: cửa sổ đang focus thì không; hook gửi kèm giờ bắt đầu (startedAt) thì chỉ nháy khi cửa sổ
 * không được focus từ lúc đó tới giờ (lastBlurAt là lần mất focus gần nhất; đã xem rồi mới rời thì thôi).
 */
export function shouldFlash(w: { focused: boolean; lastBlurAt: number; startedAt?: number }): boolean {
  if (w.focused) return false;
  if (w.startedAt && w.lastBlurAt >= w.startedAt) return false;
  return true;
}
```

Also update `learnForegroundWindow` and `flashWindowEx` to call `runPowerShell(script, 'foreground')` / `runPowerShell(script, 'flash')` from `./native` (same signature). Delete the local `runPowerShell`, `RunResult`, and the `fs`/`os`/`path`/`spawn` imports if nothing else uses them.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/attention.test.ts && npx tsc --noEmit`
Expected: attention tests PASS; `tsc` reports errors only in `src/hook.ts` (old `flashHostWindow(ancestors)` call), fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/attention.ts test/attention.test.ts
git commit -m "fix: host flash walks the whole chain for a console, ignores apps opened from the terminal, knows editors by pid"
```

---

### Task 4: `src/signal.ts` — editor pid in registry, probe-based routing for every signal

**Files:**
- Modify: `src/signal.ts`
- Test: `test/signal.test.ts`

**Interfaces:**
- Produces: `WindowEntry.editorPid?: number`; `Signal.probe?: boolean`, `Signal.startedAt?: number`; `routeSignal(signal: Signal, opts: RouteOptions, dir?, log?, alive?): Promise<RouteResult>` with `RouteOptions = { ask?: boolean; cwdFallback: boolean; prune?: boolean }`, `RouteResult = { ok: boolean; pid?: number; heard?: string; via?: 'owner' | 'cwd' }`.
- Removes: `signalAgentWindow` (replaced by `routeSignal`). `askWindow` and `signalWindow` stay for callers that have no chain (they are also what `routeSignal` uses for the cwd fallback).

- [ ] **Step 1: Write the failing tests** (replace the `signalAgentWindow` describe in `test/signal.test.ts`)

```ts
import { routeSignal } from '../src/signal';

describe('routeSignal: hỏi cửa sổ nào chứa agent (probe) rồi mới gửi', () => {
  /** Server giả của một cửa sổ: probe trả 'owned' khi pid của nó nằm trong chuỗi, 'no' nếu không; tín hiệu thật được ghi lại. */
  const win = async (pid: number, got: Signal[], heard = 'yes') => {
    const pipe = testPipe();
    const server = startServer(pipe, (s) => {
      if (s.probe) return s.ancestors?.includes(pid) ? 'owned' : 'no';
      got.push(s);
      return s.event === 'ask' ? heard : undefined;
    });
    await new Promise((r) => server.once('listening', r));
    return { pipe, server };
  };
  const sig = (event: Signal['event'], cwd: string, ancestors?: number[]): Signal =>
    ({ event, session: 's', cwd, ...(event === 'attention' ? { reason: 'done' as const } : {}), ...(ancestors ? { ancestors } : {}) });

  it('cửa sổ có pid trong chuỗi nhận tín hiệu, dù cwd khớp cửa sổ khác dài hơn (workspace cha và project con)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotParent: Signal[] = []; const gotChild: Signal[] = [];
    const parent = await win(1001, gotParent); const child = await win(1002, gotChild);
    writeRegistry({ pid: 1001, pipe: parent.pipe, folders: ['D:/parent'] }, dir);
    writeRegistry({ pid: 1002, pipe: child.pipe, folders: ['D:/parent/child'] }, dir);
    const r = await routeSignal(sig('listen', 'D:/parent/child', [500, 400, 1001, 10]), { cwdFallback: false }, dir, undefined, () => true);
    expect(r).toEqual({ ok: true, pid: 1001, via: 'owner' });
    await new Promise((r) => setTimeout(r, 50));
    expect(gotParent.map((s) => [s.event, s.probe, s.ancestors])).toEqual([['listen', undefined, [500, 400, 1001, 10]]]);
    expect(gotChild).toEqual([]);
    parent.server.close(); child.server.close();
  });

  it('ask: probe trước, rồi chỉ cửa sổ chủ nghe và trả chữ', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotA: Signal[] = []; const gotB: Signal[] = [];
    const a = await win(1001, gotA, 'allow'); const b = await win(1002, gotB, 'deny');
    writeRegistry({ pid: 1001, pipe: a.pipe, folders: ['D:/a'] }, dir);
    writeRegistry({ pid: 1002, pipe: b.pipe, folders: ['D:/a'] }, dir);
    const r = await routeSignal({ ...sig('ask', 'D:/a', [7, 1002]), timeoutSec: 1 }, { ask: true, cwdFallback: false }, dir, undefined, () => true);
    expect(r).toEqual({ ok: true, pid: 1002, via: 'owner', heard: 'deny' });
    expect(gotA).toEqual([]);
    expect(gotB.map((s) => s.event)).toEqual(['ask']);
    a.server.close(); b.server.close();
  });

  it('chuỗi hợp lệ mà không cửa sổ nào chứa agent: cwdFallback false thì không gửi cho ai (agent ở terminal rời)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotA: Signal[] = [];
    const a = await win(1001, gotA);
    writeRegistry({ pid: 1001, pipe: a.pipe, folders: ['D:/a'] }, dir);
    expect(await routeSignal(sig('attention', 'D:/a', [500, 9999]), { cwdFallback: false }, dir, undefined, () => true)).toEqual({ ok: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(gotA).toEqual([]);
    a.server.close();
  });

  it('cwdFallback true: không ai nhận thì gửi cho cửa sổ theo cwd, bỏ chuỗi pid; không có chuỗi thì gửi thẳng theo cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotA: Signal[] = [];
    const a = await win(1001, gotA);
    writeRegistry({ pid: 1001, pipe: a.pipe, folders: ['D:/a'] }, dir);
    writeRegistry({ pid: 1002, pipe: testPipe(), folders: ['D:/a'] }, dir);
    expect(await routeSignal(sig('submitted', 'D:/a/sub', [500, 9999]), { cwdFallback: true }, dir, undefined, (pid) => pid === 1001)).toEqual({ ok: true, pid: 1001, via: 'cwd' });
    expect(await routeSignal(sig('submitted', 'D:/a'), { cwdFallback: true }, dir, undefined, (pid) => pid === 1001)).toEqual({ ok: true, pid: 1001, via: 'cwd' });
    await new Promise((r) => setTimeout(r, 50));
    expect(gotA.map((s) => s.ancestors)).toEqual([undefined, undefined]);
    expect(readRegistry(dir).map((e) => e.pid)).toEqual([1001]);
    expect(await routeSignal(sig('submitted', 'D:/none'), { cwdFallback: true }, dir, undefined, () => true)).toEqual({ ok: false });
    a.server.close();
  });
});

describe('registry và parseSignal mang thêm pid editor, probe, startedAt', () => {
  it('editorPid được ghi và đọc lại; thiếu thì undefined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-reg-'));
    writeRegistry({ pid: 1, pipe: 'p', folders: ['D:/a'], editorPid: 11384 }, dir);
    writeRegistry({ pid: 2, pipe: 'q', folders: ['D:/b'] }, dir);
    const byPid = Object.fromEntries(readRegistry(dir).map((e) => [e.pid, e.editorPid]));
    expect(byPid).toEqual({ 1: 11384, 2: undefined });
  });
  it('parseSignal giữ probe, startedAt và source của attention', () => {
    const s = parseSignal(JSON.stringify({ event: 'attention', cwd: 'D:/a', reason: 'done', probe: true, startedAt: 1700000000000, source: 'copilot' }));
    expect(s).toMatchObject({ probe: true, startedAt: 1700000000000, source: 'copilot' });
    expect(parseSignal(JSON.stringify({ event: 'listen', cwd: 'D:/a', probe: 'yes', startedAt: 'x' }))).toEqual({ event: 'listen', session: '', cwd: 'D:/a' });
  });
});
```

Remove `signalAgentWindow` from the import list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/signal.test.ts`
Expected: FAIL (`routeSignal` missing; `editorPid` type error).

- [ ] **Step 3: Implement in `src/signal.ts`**

```ts
export interface WindowEntry {
  pid: number;
  pipe: string;
  folders: string[];
  /** pid tiến trình chính của editor (cha của extension host); hook coi cửa sổ của pid này là editor dù tiêu đề là gì. */
  editorPid?: number;
}

// Thêm vào Signal:
  /** Chỉ hỏi "cửa sổ này có chứa agent không" (trả 'owned' hay 'no'), không xử lý. */
  probe?: boolean;
  /** attention: lúc hook bắt đầu (Date.now()); extension bỏ nháy nếu cửa sổ đã được focus sau đó. */
  startedAt?: number;

// parseSignal: sau dòng lang
    if (o.probe === true) out.probe = true;
    if (typeof o.startedAt === 'number') out.startedAt = o.startedAt;

// readRegistry: giữ editorPid
      if (typeof e.pid === 'number' && typeof e.pipe === 'string' && Array.isArray(e.folders)) {
        out.push(typeof e.editorPid === 'number' ? e : { pid: e.pid, pipe: e.pipe, folders: e.folders });
      }
```

Replace `signalAgentWindow` with:

```ts
/** Bao lâu chờ một cửa sổ trả lời probe (chỉ so pid, không chờ nháy hay nghe). */
const OWNER_REPLY_MS = 3000;

export interface RouteOptions {
  /** ask: chờ cửa sổ nghe và trả chữ về (timeoutSec + 20 giây cho Whisper). */
  ask?: boolean;
  /**
   * Không cửa sổ nào chứa agent (hay không có chuỗi pid) thì có gửi cho cửa sổ theo cwd không. attention/listen/ask
   * để false khi đã có chuỗi: agent ở terminal rời thì không nháy, không mở mic ở một cửa sổ VS Code không liên quan.
   */
  cwdFallback: boolean;
}

export interface RouteResult {
  ok: boolean;
  pid?: number;
  via?: 'owner' | 'cwd';
  heard?: string;
}

/**
 * Gửi tín hiệu tới cửa sổ đang chứa agent. Có chuỗi pid: hỏi mọi cửa sổ còn sống bằng probe; cửa sổ thấy pid extension
 * host của mình hay shell pid của một terminal của mình trong chuỗi trả 'owned', rồi chỉ cửa sổ đó nhận tín hiệu thật.
 * Không ai nhận (hoặc không có chuỗi) và cwdFallback: gửi cho cửa sổ theo cwd, bỏ chuỗi để nó xử lý như trước.
 */
export async function routeSignal(
  signal: Signal,
  opts: RouteOptions,
  dir = WINDOWS_DIR,
  log?: (m: string) => void,
  alive: (pid: number) => boolean = pidAlive,
): Promise<RouteResult> {
  const entries = pruneRegistry(dir, alive);
  const askMs = ((signal.timeoutSec ?? 15) + 20) * 1000;
  if (signal.ancestors?.length && entries.length) {
    const probe: Signal = { ...signal, probe: true };
    const replies = await Promise.all(entries.map(async (e) => ({ e, reply: await askSignal(e.pipe, probe, OWNER_REPLY_MS) })));
    const owner = replies.find((r) => r.reply === 'owned')?.e;
    if (owner) {
      if (opts.ask) {
        const heard = await askSignal(owner.pipe, signal, askMs);
        log?.(heard === undefined ? `ask: cửa sổ pid ${owner.pid} (đang chứa agent) không trả lời` : `ask → cửa sổ pid ${owner.pid} (đang chứa agent): ${JSON.stringify(heard)}`);
        return heard === undefined ? { ok: false, pid: owner.pid, via: 'owner' } : { ok: true, pid: owner.pid, via: 'owner', heard };
      }
      const ok = await sendSignal(owner.pipe, signal);
      log?.(ok ? `signal ${signal.event} → cửa sổ pid ${owner.pid} (đang chứa agent)` : `signal ${signal.event}: cửa sổ pid ${owner.pid} không trả lời`);
      return { ok, pid: owner.pid, via: 'owner' };
    }
    log?.(`signal ${signal.event}: không cửa sổ nào chứa agent (đã hỏi ${entries.length})${opts.cwdFallback ? ', chọn theo cwd' : ', không gửi'}`);
    if (!opts.cwdFallback) return { ok: false };
  } else if (!opts.cwdFallback && signal.ancestors?.length) {
    log?.(`signal ${signal.event}: không có cửa sổ VS Code nào`);
    return { ok: false };
  }
  const { ancestors: _ancestors, ...plain } = signal;
  const entry = pickWindow(entries, plain.cwd);
  if (!entry) {
    log?.(`signal ${plain.event}: không có cửa sổ nào cho ${plain.cwd}`);
    return { ok: false };
  }
  if (opts.ask) {
    const heard = await askSignal(entry.pipe, plain, askMs);
    log?.(heard === undefined ? `ask: cửa sổ pid ${entry.pid} không trả lời` : `ask → cửa sổ pid ${entry.pid} (theo cwd): ${JSON.stringify(heard)}`);
    return heard === undefined ? { ok: false, pid: entry.pid, via: 'cwd' } : { ok: true, pid: entry.pid, via: 'cwd', heard };
  }
  const ok = await sendSignal(entry.pipe, plain);
  log?.(ok ? `signal ${plain.event} → cửa sổ pid ${entry.pid} (theo cwd)` : `signal ${plain.event}: cửa sổ pid ${entry.pid} không trả lời`);
  return { ok, pid: entry.pid, via: 'cwd' };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/signal.test.ts && npx tsc --noEmit`
Expected: signal tests PASS; `tsc` errors only in `src/hook.ts` (imports `signalAgentWindow`), fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/signal.ts test/signal.test.ts
git commit -m "feat: route every hook signal through an ownership probe; registry carries the editor pid"
```

---

### Task 5: `src/hook.ts` — agent chain with anchor cache, one PowerShell run per attention, routing for all signals

**Files:**
- Modify: `src/hook.ts` (`claudeAncestors` → `agentChain`, `attention`, `requestMicrophone`, `modePrompt`, `spawnPlay`/`play` ancestors, imports)
- Test: `test/hook-terminal.test.ts` (cache test through a shell wrapper), `test/hook.test.ts` (prefix test with live pids)

**Interfaces:**
- Consumes: `flashHostWindow(startPid, { editorPids })` and `HostFlash.chain` (Task 3); `routeSignal` (Task 4); `agentChainFrom`, `anchorIndex`, `procTable`, `procChain`, `isWrapperExe` (Task 2); `nativeScript`, `runPowerShell`, `parseChain` (Task 1).
- Session mark: `proc?: { anchor: number; chain: number[] }` (replaces `{ pid, chain }`; old marks are ignored).

- [ ] **Step 1: Update the cache test to spawn through a shell wrapper** (`test/hook-terminal.test.ts`)

Add a helper next to `run`:

```ts
/** Chạy hook qua một shell trung gian như Claude Code thật (bash -c / cmd /c): ppid của hook là shell tạm, không phải tiến trình test. */
function runWrapped(args: string[], stdin: string): Promise<number | null> {
  const cmd = [process.execPath, bundle, ...args, '--player', path.join(work, 'no-such-player.exe')].map((a) => `"${a}"`).join(' ');
  const [sh, shArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['sh', ['-c', cmd]];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, shArgs, { env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp }, stdio: ['pipe', 'ignore', 'ignore'], windowsVerbatimArguments: true });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
    child.stdin.end(stdin);
  });
}
```

Change the second test in `listen signal carries the Claude process ancestry`:

```ts
  it('reuses the chain saved for the session on the next turn, even though each hook runs under a fresh wrapper shell', async () => {
    const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
    const transcript = path.join(work, 'empty.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: '' } }));
    got.length = 0;
    expect(await runWrapped(['speak', '--config', cfg], JSON.stringify({ session_id: 'term2', cwd: work, transcript_path: transcript }))).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    // Lần đầu: tra chuỗi thật; neo là tiến trình test (node), vỏ bọc cmd/sh bị bỏ.
    expect(got.find((s) => s.event === 'listen')?.ancestors?.[0]).toBe(process.pid);
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: 'term2', cwd: work, prompt: 'làm tiếp đi' }));
    got.length = 0;
    const before = fs.readFileSync(logFile, 'utf8').length;
    expect(await runWrapped(['speak', '--config', cfg], JSON.stringify({ session_id: 'term2', cwd: work, transcript_path: transcript }))).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(logFile, 'utf8').slice(before)).toContain('proctree: dùng lại');
    expect(got.find((s) => s.event === 'listen')?.ancestors?.[0]).toBe(process.pid);
  }, 40_000);
```

Fix the prefix test in `test/hook.test.ts` so the fake windows are alive (`pruneRegistry` deletes dead pids before the hook counts windows):

```ts
    registerWindow(process.pid, work);
    expect(await spoken(cfgNormal)).toBe('Xong việc.');
    registerWindow(process.ppid, path.join(work, '..', 'other-project'));
    expect(await spoken(cfgNormal)).toBe(prefixed());
```

- [ ] **Step 2: Run the two tests to verify they fail**

Run: `npx vitest run test/hook-terminal.test.ts test/hook.test.ts -t "reuses the chain|nói tên workspace"`
Expected: FAIL (`dùng lại` never logged; `ancestors[0]` is the wrapper pid).

- [ ] **Step 3: Implement in `src/hook.ts`**

Imports:

```ts
import { signalWindow, routeSignal, readRegistry, micHolder, MIC_LOCK_MAX_AGE_MS, type Signal, type SignalSource, type AttentionReason } from './signal';
import { agentChainFrom, procTable, procChain, type ProcEntry } from './proctree';
import { flashHostWindow } from './attention';
import { nativeScript, runPowerShell, parseChain } from './native';

/** Lúc hook bắt đầu: gửi kèm attention để extension bỏ nháy nếu người dùng đã xem cửa sổ sau đó. */
const HOOK_STARTED_AT = Date.now();
```

Session mark:

```ts
  /** Chuỗi pid từ agent lên, neo = pid agent (bỏ shell bọc hook); dùng lại khi neo còn sống. */
  proc?: { anchor: number; chain: number[] };
// readMark:
    if (o.proc && typeof o.proc.anchor === 'number' && Array.isArray(o.proc.chain)) {
      mark.proc = { anchor: o.proc.anchor, chain: o.proc.chain.filter((n): n is number => typeof n === 'number') };
    }
```

Replace `claudeAncestors`:

```ts
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Chuỗi tiến trình từ cha của hook lên (Windows: Toolhelp32 trong helper; nơi khác: ps). */
async function rawChain(): Promise<ProcEntry[]> {
  if (!process.ppid) return [];
  if (process.platform === 'win32') {
    const r = await runPowerShell(nativeScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[NoIdleNative]::Chain(${process.ppid}, 14) | ForEach-Object { [Console]::Out.WriteLine("chain\`t" + $_) }
exit 0`), 'chain');
    return r.code === 0 ? parseChain(r.out) : [];
  }
  return procChain(process.ppid, await procTable());
}

/**
 * Chuỗi pid từ agent (Claude Code, Copilot CLI, extension host của Copilot Chat) lên tới shell của terminal và editor.
 * Hook bị bash/cmd/powershell bọc nên ppid đổi mỗi lần; neo là tiến trình đầu tiên không phải vỏ bọc, còn sống thì
 * dùng lại chuỗi đã lưu theo phiên. fresh: chuỗi script nháy vừa in ra, khỏi tra lần nữa.
 */
async function agentChain(session: string, fresh?: ProcEntry[]): Promise<number[]> {
  const mark = session ? readMark(session) : undefined;
  if (!fresh && mark?.proc && mark.proc.chain.length && pidAlive(mark.proc.anchor)) {
    log(`proctree: dùng lại chuỗi đã lưu của phiên (${mark.proc.chain.join(' ← ')})`);
    return mark.proc.chain;
  }
  const t0 = Date.now();
  const entries = fresh ?? (await rawChain());
  const chain = agentChainFrom(entries);
  log(`proctree: ${entries.map((e) => `${e.pid} ${e.exe}`).join(' ← ') || 'rỗng'} → agent ${chain.join(' ← ') || 'rỗng'} (${Date.now() - t0}ms)`);
  if (session && chain.length > 1) writeMark(session, { ...readMark(session), proc: { anchor: chain[0], chain } });
  return chain;
}
```

`attention`:

```ts
async function attention(reason: AttentionReason, session: string, cwd: string, cfg: HookConfig = {}): Promise<boolean> {
  let ancestors: number[];
  if (cfg.attentionFlash !== false && process.env.VI_VOICE_HOST_FLASH !== '0' && process.platform === 'win32') {
    // Một lần PowerShell: tra chuỗi pid, nháy terminal rời nếu agent ở đó; cửa sổ editor thì để extension nháy.
    const t0 = Date.now();
    const editorPids = readRegistry().map((e) => e.editorPid).filter((p): p is number => typeof p === 'number');
    const host = await flashHostWindow(process.ppid, { editorPids });
    log(`attention ${reason}: nháy cửa sổ chứa agent → ${host.result}${host.window ? ` (${host.window})` : ''} (${Date.now() - t0}ms)`);
    ancestors = await agentChain(session, host.chain.length ? host.chain : undefined);
    if (host.result === 'flashed' || host.result === 'foreground') return true;
  } else {
    if (cfg.attentionFlash === false) log(`attention ${reason}: attentionFlash tắt, không nháy cửa sổ chứa agent`);
    ancestors = await agentChain(session);
  }
  const signal: Signal = { event: 'attention', session, cwd, reason, ancestors, source: sourceArg(), startedAt: HOOK_STARTED_AT };
  return routeSignal(signal, { cwdFallback: ancestors.length === 0 }, undefined, log)
    .then((r) => r.ok)
    .catch((err) => {
      log(`signal attention lỗi: ${(err as Error).message}`);
      return false;
    });
}
```

`requestMicrophone` (Copilot Chat now gets a chain too, so two windows on one folder route correctly):

```ts
    const ancestors = await agentChain(signal.session);
    await waitTurn(ticket);
    if (listTickets()[0]?.file !== ticket || !loadConfig().handsFree || readMark(signal.session).count !== promptCount) return;
    const request = { ...signal, ancestors, source: sourceArg() };
    const r = await routeSignal(request, { ask: signal.event === 'ask', cwdFallback: ancestors.length === 0 }, undefined, log);
    return signal.event === 'ask' ? r.heard : undefined;
```

`modePrompt` submitted and resumed, `modeNotify` chatPending/chatDone: replace `signalWindow({...})` with

```ts
await routeSignal({ ...signal, ancestors: await agentChain(input.session_id ?? '') }, { cwdFallback: true }, undefined, log);
```

(`signalWindow`'s `prune=false` for chatPending/chatDone is no longer needed: `routeSignal` prunes by liveness, not by reply.)

`modeSpeak` line 570 and `play` mode: replace `claudeAncestors(process.ppid, session)` with `agentChain(session)`, and in `play` replace `claudeAncestors(Number(arg('claude-pid','0')), …)` with `agentChain(session === '-' ? '' : session)` (the cached chain survives the per-hook shell; `--claude-pid` is no longer read; keep passing it for compatibility or drop both sides).

In `play`'s listen: `await signalWindow(...)` → `await routeSignal({ ...signalBody, ancestors }, { cwdFallback: ancestors.length === 0 }, undefined, log)`.

- [ ] **Step 4: Typecheck, run hook tests**

Run: `npx tsc --noEmit && npx vitest run test/hook-terminal.test.ts test/hook.test.ts test/copilot-hook.test.ts test/hook-auto.test.ts test/hook-en.test.ts test/hook-mic.test.ts`
Expected: PASS. The 4 former 5 s timeouts should disappear because the chain now takes well under a second. If the Copilot tests' fake extension (test/copilot-hook.test.ts line ~106) must answer probes, change it to `if (signal.probe) return signal.ancestors?.includes(process.pid) ? 'owned' : 'no';` before the existing attention branch.

- [ ] **Step 5: Commit**

```bash
git add src/hook.ts test/hook-terminal.test.ts test/hook.test.ts test/copilot-hook.test.ts
git commit -m "fix: hook caches the agent chain by anchor, one PowerShell run per attention, every signal routed by owner"
```

---

### Task 6: `src/extension.ts` and `src/status.ts` — register editor pid, answer probes, freshness guard, label by source, window tag in log

**Files:**
- Modify: `src/extension.ts:219-230` (log), `:268` (agentLabel), `:1160-1183` (onSignal), `:1292-1323` (onAttention), `:1353-1360` (window state), `:1364-1372` (registerWindow)
- Modify: `src/status.ts:36` (`attention(reason, lang, agent?)`)

**Interfaces:**
- Consumes: `shouldFlash` (Task 3), `Signal.probe/startedAt`, `WindowEntry.editorPid` (Task 4).

- [ ] **Step 1: Log tag**

```ts
  const windowTag = () => vscode.workspace.name ?? path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || `pid ${process.pid}`;
  const log = (msg: string) => {
    const line = `${new Date().toLocaleTimeString('vi-VN')} [${windowTag()}] ${msg}`;
```

- [ ] **Step 2: Register the editor pid**

```ts
      writeRegistry({ pid: process.pid, pipe, folders, editorPid: process.ppid });
```

- [ ] **Step 3: Probe reply and attention handling in `onSignal`**

```ts
    if (s.probe) {
      // Hook hỏi mọi cửa sổ: extension host này (Copilot Chat) hay một terminal của cửa sổ này (Claude Code, Copilot CLI)
      // nằm trong chuỗi pid thì mới là cửa sổ chứa agent. Chỉ trả lời, không xử lý.
      return (await agentInWindow(s.ancestors, process.pid, vscode.window.terminals)) ? 'owned' : 'no';
    }
    if (s.source) agentLabel = s.source === 'claude' ? 'Claude' : 'Copilot';
    ...
    if (s.event === 'attention') return onAttention(s.reason ?? 'done', s.startedAt);
```

(Delete the old `if (s.ancestors?.length) { agentInWindow … return 'owned' }` block: routing happened in the probe.)

- [ ] **Step 4: Freshness guard and label in `onAttention`**

```ts
  /** Lần cửa sổ mất focus gần nhất (ms); 0 nếu chưa từng focus từ khi extension chạy. */
  let lastBlurAt = 0;

  async function onAttention(reason: AttentionReason, startedAt?: number): Promise<void> {
    const cfg = config();
    if (!shouldFlash({ focused: vscode.window.state.focused, lastBlurAt, startedAt })) {
      log(`attention ${reason}: ${vscode.window.state.focused ? 'cửa sổ đang focus' : 'người dùng đã xem cửa sổ sau khi agent xong'}, bỏ qua`);
      return;
    }
    if (cfg.attentionColor) {
      status.attention(reason, langOf(cfg.language), agentLabel);
      ...
```

and in the window-state listener:

```ts
    vscode.window.onDidChangeWindowState((st) => {
      if (st.focused) {
        clearAttention();
        void learnMyWindow();
      } else lastBlurAt = Date.now();
    }),
```

`src/status.ts`:

```ts
  attention(reason: AttentionReason, lang: Lang = this.lang, agent?: string): void {
    if (agent) this.agent = agent;
    this.attentionReason = reason;
```

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors; `dist/extension.js` and `dist/claude-hook.js` rebuilt.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts src/status.ts
git commit -m "fix: extension registers its editor pid, answers ownership probes, skips flashes the user already saw"
```

---

### Task 7: Full verification, local install, memory

**Files:**
- Modify: `C:\Users\Admin\.claude\projects\D--Project-vi-voice\memory\flash-routing-review-2026-10-03.md` (mark fixed), `MEMORY.md` line.

- [ ] **Step 1: Full test run**

Run: `npx vitest run`
Expected: all green (previous baseline: 5 failures, all explained by the slow chain lookup and the dead-pid prefix test).

- [ ] **Step 2: Live smoke on this machine (read-only where possible)**

Run the chain script directly and confirm the DLL exists and a second run is fast:

```powershell
Get-ChildItem $env:TEMP\noidle-tts\native
Measure-Command { powershell -NoProfile -File $env:TEMP\noidle-tts\chain-<pid>.ps1 }
```
Expected: one `noidle-native-*.dll`; second run under 1 s.

- [ ] **Step 3: Package and install locally without a version bump**

Run: `npm run package && code --install-extension noidle-1.0.28.vsix --force`
Then reload the VS Code windows that should pick up the new extension; the hook file is rewritten by the extension on activation.

- [ ] **Step 4: Update memory**

In `flash-routing-review-2026-10-03.md`, change the first line of the body to "Fixed on 2026-10-03 (commits on feat/vi-voice), live verification pending" and list what to look for in `hook.log`: `proctree: dùng lại`, `[console]` lines for standalone terminals, host-flash times under 1500 ms.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: cover wrapper-shell chain cache and owner routing; fix stale prefix test"
```

(Only if files remain uncommitted from earlier tasks.)
