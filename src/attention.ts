/**
 * Làm nổi cửa sổ VS Code của workspace vừa có việc (Claude xong, cần approve, cần trả lời) khi người dùng
 * mở nhiều cửa sổ: nháy nút trên taskbar Windows (FlashWindowEx) cho tới khi cửa sổ đó lên foreground.
 * VS Code không có API cho việc này nên gọi user32 qua PowerShell. macOS dùng blinkTitleBar ở cuối file.
 * Tất cả cửa sổ VS Code chung một tiến trình chính, nên chọn cửa sổ theo tiêu đề: tiêu đề mặc định luôn có
 * tên workspace giữa hai dấu " - " ("hook.ts - vi-voice - Visual Studio Code").
 */
import { nativeScript, runPowerShell, parseChain, type RunResult } from './native';
import type { ProcEntry } from './proctree';
export type { RunResult } from './native';

/**
 * Tiêu đề là của VS Code và có đúng tên workspace là một đoạn riêng. Tiêu đề mặc định
 * "file - workspace - [profile -] Visual Studio Code": đoạn đầu là tên file đang mở, có thể trùng tên workspace khác,
 * nên không tính khi tiêu đề có từ 3 đoạn.
 */
export function windowTitleMatches(title: string, workspaceName: string, opts: { hasEditor?: boolean } = {}): boolean {
  const t = title.toLowerCase();
  if (!t.includes('visual studio code')) return false;
  const name = workspaceName.toLowerCase().trim();
  // Multi-root: tiêu đề ghi "tên (Workspace)"; tên truyền vào có thể có hoặc không có hậu tố đó.
  const bare = name.replace(/ \(workspace\)$/, '');
  const parts = t.split(' - ').map((p) => p.replace(/^[●○•*]\s*/, '').trim());
  // hasEditor false (extension biết cửa sổ không mở tab nào): đoạn đầu là workspace, kể cả khi có tên profile
  // ("vi-voice - Work - Visual Studio Code"). Không biết thì coi như có editor.
  const skipFirst = opts.hasEditor !== false && parts.length >= 3;
  const candidates = skipFirst ? parts.slice(1) : parts;
  return candidates.some((p) => p === bare || p === `${bare} (workspace)`);
}

/** Handle cửa sổ (số thập phân từ script) hợp lệ thì trả về, không thì '0' (script tìm theo tên). */
function hwndArg(hwnd: string | undefined): string {
  return hwnd && /^\d{1,19}$/.test(hwnd) ? hwnd : '0';
}

/**
 * Script PowerShell: nháy cửa sổ VS Code tới khi nó lên foreground. Có handle đã học (xem learnForegroundWindow) và
 * cửa sổ còn đó thì nháy thẳng handle; không thì tìm cửa sổ có tên workspace trong tiêu đề (hai cửa sổ trùng tên
 * thì cách này có thể chọn nhầm). Exit 0 nháy, 2 không thấy, 3 đang ở foreground; +10 nếu handle đã học sai.
 */
export function flashScript(workspaceName: string, hwnd?: string, hasEditor = true): string {
  const name = workspaceName.replace(/'/g, "''");
  return nativeScript(`
$ws = '${name}'.ToLowerInvariant() -replace ' \\(workspace\\)$', ''
exit [NoIdleNative]::FlashWindow($ws, ${hwndArg(hwnd)}, ${hasEditor ? '$true' : '$false'})`);
}

/** Script PowerShell: in "hwnd<tab>tiêu đề" của cửa sổ đang ở foreground (handle dạng số thập phân). */
export function foregroundWindowScript(): string {
  return nativeScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([NoIdleNative]::Foreground())`);
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
  /** Chạy script, trả exit code (kèm stdout nếu có). Mặc định: ghi ra file tạm rồi gọi powershell -File (native.ts). */
  run?: (script: string) => Promise<number | RunResult>;
  /** flashWindow: handle cửa sổ đã học (learnForegroundWindow); có thì nháy thẳng, không cần tìm theo tên. */
  hwnd?: string;
  /** flashWindow: cửa sổ đang mở tab nào không (tabGroups); false thì đoạn đầu tiêu đề là workspace. Mặc định có. */
  hasEditor?: boolean;
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
  const run = deps.run ?? ((script) => runPowerShell(script, 'flash'));
  let code: number;
  try {
    code = codeOf(await run(flashScript(workspaceName, deps.hwnd, deps.hasEditor !== false)));
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
export function acceptLearnedWindow(w: ForegroundWindow, workspaceName: string, stillFocused: boolean, hasEditor = true): boolean {
  if (!stillFocused) return false;
  if (!workspaceName) return true;
  return windowTitleMatches(w.title, workspaceName, { hasEditor });
}

/**
 * Agent chạy ở terminal rời (Windows Terminal, cmd, PowerShell): không có extension nào để nháy hộ, hook tự nháy
 * cửa sổ đang chứa tiến trình agent. Script tự tra chuỗi pid từ startPid (cha của hook) bằng Toolhelp32 rồi in
 * chuỗi ra để hook dùng lại, không cần tra bảng tiến trình riêng (CIM mất 5 đến 15 giây).
 *
 * Bước 1, theo console: duyệt cả chuỗi, attach vào console của từng pid. Hook bị bash/cmd/powershell bọc, console của
 * chúng ẩn nên đi tiếp tới console của agent. Windows Terminal trả một PseudoConsoleWindow mà owner gốc
 * (GetAncestor GA_ROOTOWNER) là cửa sổ WT; conhost cổ điển trả thẳng cửa sổ console; conpty của VS Code thì owner
 * là chính nó, bỏ qua.
 *
 * Bước 2, theo cây tiến trình: cửa sổ của chính pid trong chuỗi, hoặc của con nó khi con là console host (conhost);
 * app người dùng mở từ terminal (notepad, trình duyệt) không được nhận. Ưu tiên cửa sổ có tiêu đề trùng tiêu đề
 * console của agent (WT nhiều cửa sổ). explorer.exe bị bỏ qua.
 *
 * editorPids: pid tiến trình chính của các editor đang mở (extension đăng ký); cửa sổ của chúng, hay có
 * "Visual Studio Code" trong tiêu đề, trả 4 để extension nháy theo tên workspace. Exit 0 nháy, 2 không thấy,
 * 3 đang ở foreground, 4 là editor.
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

/** Nháy cửa sổ chứa agent theo chuỗi pid tổ tiên của startPid. 'vscode': để extension nháy theo tên workspace. */
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
/**
 * Mốc mất focus mới: chỉ đổi khi focused chuyển true → false. onDidChangeWindowState còn bắn khi `active` đổi (người
 * dùng không gõ gì một lúc) với focused vẫn false; lấy giờ lúc đó thì shouldFlash tưởng người dùng vừa xem cửa sổ.
 */
export function nextBlurAt(s: { prevFocused: boolean; focused: boolean; prevBlurAt: number; now: number }): number {
  return s.prevFocused && !s.focused ? s.now : s.prevBlurAt;
}

export function shouldFlash(w: { focused: boolean; lastBlurAt: number; startedAt?: number }): boolean {
  if (w.focused) return false;
  if (w.startedAt && w.lastBlurAt >= w.startedAt) return false;
  return true;
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

/**
 * Màu còn sót trong settings workspace sau khi extension khởi động lại (tắt máy lúc đang tô: lệnh gỡ trong dispose
 * không kịp ghi). remembered: màu đã tô mà extension ghi vào workspaceState trước khi tô; configured: màu trong setting
 * hiện tại (bản cũ không nhớ gì). Có màu của mình trong file thì trả bảng màu sau khi gỡ; không thì undefined.
 */
export function staleTintPlan(input: { current: ColorMap | undefined; remembered?: string; configured: string; shell: string }): { bg: string; next: ColorMap | undefined } | undefined {
  const found = input.current?.['titleBar.activeBackground'];
  if (typeof found !== 'string') return undefined;
  const bg = [input.remembered, input.configured].find((c) => c && c === found);
  if (!bg) return undefined;
  return { bg, next: removeTint(input.current, {}, input.shell, bg) };
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
