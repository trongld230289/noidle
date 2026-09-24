/**
 * Làm nổi cửa sổ VS Code của workspace vừa có việc (Claude xong, cần approve, cần trả lời) khi người dùng
 * mở nhiều cửa sổ: nháy nút trên taskbar Windows (FlashWindowEx) cho tới khi cửa sổ đó lên foreground.
 * VS Code không có API cho việc này nên gọi user32 qua PowerShell; các hệ khác chưa hỗ trợ.
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

/** Script PowerShell: tìm cửa sổ VS Code có tên workspace trong tiêu đề rồi nháy tới khi nó lên foreground. Exit 0 nháy, 2 không thấy, 3 đang ở foreground. */
export function flashScript(workspaceName: string): string {
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
  public static int Flash(string workspace) {
    Handles.Clear(); Titles.Clear();
    EnumWindows(Collect, IntPtr.Zero);
    IntPtr fg = GetForegroundWindow();
    for (int i = 0; i < Titles.Count; i++) {
      var t = Titles[i].ToLowerInvariant();
      if (!t.Contains("visual studio code")) continue;
      bool hit = false;
      foreach (var raw in t.Split(new string[] { " - " }, StringSplitOptions.None)) {
        var p = raw.TrimStart('\\u25CF', '\\u25CB', '\\u2022', '*', ' ').Trim();
        if (p == workspace || p == workspace + " (workspace)") { hit = true; break; }
      }
      if (!hit) continue;
      if (Handles[i] == fg) return 3;
      var f = new FLASHWINFO();
      f.cbSize = (uint)Marshal.SizeOf(f);
      f.hwnd = Handles[i];
      f.dwFlags = ${FLASHW_ALL | FLASHW_TIMERNOFG};
      f.uCount = 0;
      f.dwTimeout = 0;
      FlashWindowEx(ref f);
      return 0;
    }
    return 2;
  }
}
"@
$ws = '${name}'.ToLowerInvariant() -replace ' \(workspace\)$', ''
exit [NoIdleWin]::Flash($ws)
`;
}

export type FlashResult = 'flashed' | 'not-found' | 'foreground' | 'unsupported' | 'error';

export interface FlashDeps {
  platform?: NodeJS.Platform;
  /** Chạy script, trả exit code. Mặc định: ghi ra file tạm rồi gọi powershell -File. */
  run?: (script: string) => Promise<number>;
}

async function runPowerShell(script: string): Promise<number> {
  const dir = path.join(os.tmpdir(), 'noidle-tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `flash-${process.pid}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/** Nháy nút taskbar của cửa sổ VS Code có tên workspace này. Không ném lỗi; kết quả để ghi log. */
export async function flashWindow(workspaceName: string, deps: FlashDeps = {}): Promise<FlashResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return 'unsupported';
  const run = deps.run ?? runPowerShell;
  let code: number;
  try {
    code = await run(flashScript(workspaceName));
  } catch {
    return 'error';
  }
  if (code === 0) return 'flashed';
  if (code === 2) return 'not-found';
  if (code === 3) return 'foreground';
  return 'error';
}

/**
 * Tô màu title bar của cửa sổ đang cần người dùng. VS Code không có API đổi màu khung theo cửa sổ, chỉ có
 * workbench.colorCustomizations ở mức workspace (cách Peacock dùng), nên extension ghi vào đó rồi trả lại khi xong.
 */
export const TINT = {
  activeBackground: '#f0a020',
  inactiveBackground: '#c98416',
  foreground: '#1b1200',
};

export type ColorMap = Record<string, string>;

const TINT_KEYS: ColorMap = {
  'titleBar.activeBackground': TINT.activeBackground,
  'titleBar.inactiveBackground': TINT.inactiveBackground,
  'titleBar.activeForeground': TINT.foreground,
  'titleBar.inactiveForeground': TINT.foreground,
};

/** Thêm màu title bar vào bảng màu hiện có; saved giữ giá trị cũ của đúng các khoá bị ghi đè để trả lại. */
export function applyTint(current: ColorMap | undefined): { next: ColorMap; saved: ColorMap } {
  const next: ColorMap = { ...(current ?? {}) };
  const saved: ColorMap = {};
  for (const [k, v] of Object.entries(TINT_KEYS)) {
    if (typeof next[k] === 'string') saved[k] = next[k];
    next[k] = v;
  }
  return { next, saved };
}

/** Bỏ màu đã tô: trả giá trị cũ, xoá khoá mình thêm; khoá người dùng đã tự đổi trong lúc đó thì giữ. Rỗng thì undefined. */
export function removeTint(current: ColorMap | undefined, saved: ColorMap): ColorMap | undefined {
  const next: ColorMap = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(TINT_KEYS)) {
    if (next[k] !== v) continue;
    if (k in saved) next[k] = saved[k];
    else delete next[k];
  }
  return Object.keys(next).length ? next : undefined;
}
