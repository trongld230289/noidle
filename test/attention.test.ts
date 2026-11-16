import { describe, it, expect } from 'vitest';
import { windowTitleMatches, flashScript, flashWindow, flashHostScript, flashHostWindow, applyTint, removeTint, shellColorFor, tintForeground, normalizeHex, TINT, foregroundWindowScript, parseForegroundWindow, learnForegroundWindow, acceptLearnedWindow, flashWindowEx, shouldFlash, nextBlurAt, staleTintPlan } from '../src/attention';
import { NATIVE_SOURCE } from '../src/native';

describe('attention: tìm cửa sổ VS Code theo tiêu đề', () => {
  it('khớp tiêu đề mặc định "file - workspace - Visual Studio Code"', () => {
    expect(windowTitleMatches('● hook.ts - vi-voice - Visual Studio Code', 'vi-voice')).toBe(true);
    expect(windowTitleMatches('vi-voice - Visual Studio Code', 'vi-voice')).toBe(true);
    expect(windowTitleMatches('README.md - vi-voice - Visual Studio Code - Insiders', 'vi-voice')).toBe(true);
  });
  it('không khớp workspace khác, tên chỉ là một phần của tên khác, hay app khác', () => {
    expect(windowTitleMatches('main.go - acme-be - Visual Studio Code', 'vi-voice')).toBe(false);
    expect(windowTitleMatches('a.ts - vi-voice-2 - Visual Studio Code', 'vi-voice')).toBe(false);
    expect(windowTitleMatches('vi-voice - Google Chrome', 'vi-voice')).toBe(false);
  });
  it('khớp workspace multi-root "tên (Workspace)" và tiêu đề có đuôi [Administrator]', () => {
    expect(windowTitleMatches('● vitest.config.ts - vi-voice (Workspace) - Visual Studio Code [Administrator]', 'vi-voice')).toBe(true);
    expect(windowTitleMatches('● vitest.config.ts - vi-voice (Workspace) - Visual Studio Code', 'vi-voice (Workspace)')).toBe(true);
  });
  it('không phân biệt hoa thường', () => {
    expect(windowTitleMatches('x.ts - VI-Voice - Visual Studio Code', 'vi-voice')).toBe(true);
  });
  it('tên workspace ở đoạn đầu (tên file đang mở) không tính khi tiêu đề có từ 3 đoạn', () => {
    expect(windowTitleMatches('Research - vi-voice - Visual Studio Code', 'Research')).toBe(false);
    expect(windowTitleMatches('Research - Visual Studio Code', 'Research')).toBe(true);
    expect(windowTitleMatches('a.ts - Research - Default - Visual Studio Code', 'Research')).toBe(true);
  });
  it('cửa sổ không mở editor nào (extension biết qua tabGroups): đoạn đầu là workspace, kể cả khi có tên profile', () => {
    // Profile "Work", không có tab nào: "vi-voice - Work - Visual Studio Code" có 3 đoạn mà đoạn đầu là workspace.
    expect(windowTitleMatches('vi-voice - Work - Visual Studio Code', 'vi-voice', { hasEditor: false })).toBe(true);
    expect(windowTitleMatches('vi-voice - Work - Visual Studio Code', 'vi-voice', { hasEditor: true })).toBe(false);
    expect(windowTitleMatches('Research - vi-voice - Visual Studio Code', 'Research', { hasEditor: true })).toBe(false);
    expect(acceptLearnedWindow({ hwnd: '1', title: 'vi-voice - Work - Visual Studio Code' }, 'vi-voice', true, false)).toBe(true);
  });
});

describe('attention: script PowerShell nháy taskbar', () => {
  it('gọi FlashWindow của helper (cờ FLASHW_ALL | FLASHW_TIMERNOFG) với tên workspace đã escape, hwnd và cờ có editor', () => {
    const s = flashScript("it's - acme", '4242');
    expect(s).toContain('FlashWindowEx');
    expect(s).toContain('FLASH_FLAGS = 15');
    expect(s).toContain("'it''s - acme'");
    expect(s).toContain('[NoIdleNative]::FlashWindow($ws, 4242, $true)');
    expect(flashScript('x')).toContain('FlashWindow($ws, 0, $true)');
    expect(flashScript('x', 'abc', false)).toContain('FlashWindow($ws, 0, $false)');
    expect(NATIVE_SOURCE).toContain('TitleMatches(string title, string workspace, bool hasEditor)');
  });
});

describe('attention: flashWindow', () => {
  it('ngoài Windows thì báo unsupported, không chạy gì', async () => {
    let spawned = 0;
    const r = await flashWindow('vi-voice', { platform: 'linux', run: async () => { spawned++; return 0; } });
    expect(r).toBe('unsupported');
    expect(spawned).toBe(0);
  });
  it('Windows: chạy script, exit 0 là flashed, exit 2 là không tìm thấy cửa sổ', async () => {
    const seen: string[] = [];
    const run = (code: number) => async (script: string) => { seen.push(script); return code; };
    expect(await flashWindow('vi-voice', { platform: 'win32', run: run(0) })).toBe('flashed');
    expect(await flashWindow('vi-voice', { platform: 'win32', run: run(2) })).toBe('not-found');
    expect(seen[0]).toContain('FlashWindowEx');
  });
});

describe('attention: gỡ màu còn sót sau khi tắt máy (staleTintPlan)', () => {
  // 3/10/2026: tắt máy lúc cửa sổ đang tô, lệnh gỡ trong dispose không kịp ghi; mở lại thì extension chỉ gỡ khi màu
  // trong file bằng đúng màu setting hiện tại. Nhớ màu đã tô trong workspaceState để gỡ chắc chắn.
  const shell = '#181818';
  const tinted = (bg: string) => ({ 'titleBar.activeBackground': bg, 'titleBar.inactiveBackground': bg, 'titleBar.activeForeground': '#ffffff', 'titleBar.inactiveForeground': '#ffffff', 'modernUI.shellBackground': shell, 'modernUI.inactiveShellBackground': shell, 'editor.background': '#000000' });
  it('màu đã nhớ khác màu setting hiện tại: vẫn gỡ đúng màu đã nhớ', () => {
    const plan = staleTintPlan({ current: tinted('#15803d'), remembered: '#15803d', configured: '#ff0000', shell });
    expect(plan).toEqual({ bg: '#15803d', next: { 'editor.background': '#000000' } });
  });
  it('không nhớ gì (bản cũ) nhưng file có màu bằng màu setting: gỡ như trước', () => {
    expect(staleTintPlan({ current: tinted('#15803d'), configured: '#15803d', shell })?.bg).toBe('#15803d');
  });
  it('file sạch hay không có màu của mình thì không có gì để gỡ, kể cả khi còn nhớ', () => {
    expect(staleTintPlan({ current: undefined, remembered: '#15803d', configured: '#15803d', shell })).toBeUndefined();
    expect(staleTintPlan({ current: { 'titleBar.activeBackground': '#123456' }, remembered: '#15803d', configured: '#15803d', shell })).toBeUndefined();
  });
  it('gỡ hết thì next là undefined để xoá khoá colorCustomizations', () => {
    const { 'editor.background': _e, ...onlyTint } = tinted('#15803d');
    expect(staleTintPlan({ current: onlyTint, remembered: '#15803d', configured: '#15803d', shell })).toEqual({ bg: '#15803d', next: undefined });
  });
});

describe('attention: tô màu title bar qua workbench.colorCustomizations', () => {
  it('applyTint thêm màu title bar, nhớ giá trị cũ của đúng các khoá đó', () => {
    const { next, saved } = applyTint({ 'editor.background': '#111', 'titleBar.activeBackground': '#abc' }, '#181818');
    expect(next['editor.background']).toBe('#111');
    expect(next['titleBar.activeBackground']).toBe(TINT.activeBackground);
    expect(next['titleBar.inactiveBackground']).toBe(TINT.inactiveBackground);
    expect(next['titleBar.activeForeground']).toBe(TINT.foreground);
    expect(saved).toEqual({ 'titleBar.activeBackground': '#abc' });
  });
  it('applyTint giữ nền chrome (modernUI.shellBackground) màu gốc để chỉ title bar đổi màu, không viền quanh các phần', () => {
    const { next } = applyTint({}, '#181818');
    expect(next['modernUI.shellBackground']).toBe('#181818');
    // Cửa sổ cần báo thường đang ở phía sau: VS Code dùng khoá inactive cho nền chrome lúc đó.
    expect(next['modernUI.inactiveShellBackground']).toBe('#181818');
    // Người dùng đã tự đặt nền chrome thì giữ của họ.
    expect(applyTint({ 'modernUI.shellBackground': '#222' }, '#181818').next['modernUI.shellBackground']).toBe('#222');
  });
  it('removeTint trả lại giá trị cũ, xoá khoá mình thêm kể cả nền chrome, không đụng khoá khác; rỗng thì undefined', () => {
    const { next, saved } = applyTint({ 'editor.background': '#111', 'titleBar.activeBackground': '#abc' }, '#181818');
    expect(removeTint(next, saved, '#181818')).toEqual({ 'editor.background': '#111', 'titleBar.activeBackground': '#abc' });
    expect(removeTint(applyTint(undefined, '#181818').next, {}, '#181818')).toBeUndefined();
  });
  it('removeTint không ghi đè màu người dùng đã đổi trong lúc đang tô', () => {
    const { next, saved } = applyTint({}, '#181818');
    const edited = { ...next, 'titleBar.activeBackground': '#123456' };
    expect(removeTint(edited, saved, '#181818')).toEqual({ 'titleBar.activeBackground': '#123456' });
  });
  it('tintForeground: chữ trắng trên nền tối, chữ tối trên nền sáng', () => {
    expect(tintForeground('#15803d')).toBe('#ffffff');
    expect(tintForeground('#f5d76e')).toBe('#1f1a00');
  });
  it('normalizeHex: nhận #rgb và #rrggbb, sai thì về mặc định', () => {
    expect(normalizeHex('#15803D', '#111111')).toBe('#15803d');
    expect(normalizeHex('#abc', '#111111')).toBe('#aabbcc');
    expect(normalizeHex('blue', '#111111')).toBe('#111111');
    expect(normalizeHex('', '#111111')).toBe('#111111');
  });
  it('applyTint/removeTint dùng màu người dùng chọn thay cho mặc định', () => {
    const { next, saved } = applyTint({}, '#181818', '#6d28d9');
    expect(next['titleBar.activeBackground']).toBe('#6d28d9');
    expect(next['titleBar.activeForeground']).toBe('#ffffff');
    expect(removeTint(next, saved, '#181818', '#6d28d9')).toBeUndefined();
  });
  it('shellColorFor: màu nền chrome gốc theo loại theme', () => {
    expect(shellColorFor('dark')).toBe('#181818');
    expect(shellColorFor('light')).toBe('#f8f8f8');
    expect(shellColorFor('hcDark')).toBe('#000000');
    expect(shellColorFor('hcLight')).toBe('#ffffff');
  });
});

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

describe('attention: mốc mất focus chỉ đổi khi cửa sổ thật sự mất focus', () => {
  it('nextBlurAt: focused true→false thì lấy giờ hiện tại; sự kiện khác (active đổi khi cửa sổ vẫn không focus) giữ mốc cũ', () => {
    // VS Code bắn onDidChangeWindowState cả khi `active` đổi; cửa sổ đang không focus mà mốc nhảy lên thì shouldFlash
    // tưởng người dùng vừa xem và bỏ nháy nhầm.
    expect(nextBlurAt({ prevFocused: true, focused: false, prevBlurAt: 100, now: 500 })).toBe(500);
    expect(nextBlurAt({ prevFocused: false, focused: false, prevBlurAt: 100, now: 500 })).toBe(100);
    expect(nextBlurAt({ prevFocused: false, focused: true, prevBlurAt: 100, now: 500 })).toBe(100);
    expect(nextBlurAt({ prevFocused: true, focused: true, prevBlurAt: 100, now: 500 })).toBe(100);
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

describe('attention: học handle cửa sổ của chính mình lúc được focus', () => {
  it('script lấy cửa sổ foreground qua helper và in "hwnd<tab>tiêu đề"', () => {
    const s = foregroundWindowScript();
    expect(s).toContain('[NoIdleNative]::Foreground()');
    expect(NATIVE_SOURCE).toContain('h.ToInt64().ToString() + "\\t" + TitleOf(h)');
  });
  it('parseForegroundWindow: đọc hwnd và tiêu đề; không phải VS Code hay dòng hỏng thì undefined', () => {
    expect(parseForegroundWindow('1234567\t● hook.ts - vi-voice - Visual Studio Code\r\n')).toEqual({ hwnd: '1234567', title: '● hook.ts - vi-voice - Visual Studio Code' });
    expect(parseForegroundWindow('1234567\tvi-voice - Google Chrome')).toBeUndefined();
    expect(parseForegroundWindow('abc\tx - Visual Studio Code')).toBeUndefined();
    expect(parseForegroundWindow('')).toBeUndefined();
  });
  it('learnForegroundWindow: ngoài Windows thì undefined, không chạy gì; Windows thì trả cửa sổ đã đọc', async () => {
    let ran = 0;
    expect(await learnForegroundWindow({ platform: 'darwin', run: async () => (ran++, { code: 0, out: '1\tx - Visual Studio Code' }) })).toBeUndefined();
    expect(ran).toBe(0);
    expect(await learnForegroundWindow({ platform: 'win32', run: async () => ({ code: 0, out: '99\ta.ts - vi-voice - Visual Studio Code' }) })).toEqual({ hwnd: '99', title: 'a.ts - vi-voice - Visual Studio Code' });
    expect(await learnForegroundWindow({ platform: 'win32', run: async () => ({ code: 1, out: '' }) })).toBeUndefined();
  });
});

describe('attention: nháy theo handle đã học thay vì theo tên (hai cửa sổ trùng tên)', () => {
  it('flashScript có hwnd thì kiểm tra IsWindow rồi nháy thẳng handle đó, chỉ tìm theo tên khi handle không còn', () => {
    const s = flashScript('vi-voice', '1234567');
    expect(s).toContain('IsWindow(');
    expect(s).toContain('FlashWindow($ws, 1234567, $true)');
    expect(flashScript('vi-voice')).toContain('FlashWindow($ws, 0, $true)');
  });
  it('flashWindow đưa hwnd vào script', async () => {
    let script = '';
    const run = async (s: string) => ((script = s), 0);
    expect(await flashWindow('vi-voice', { platform: 'win32', run, hwnd: '4242' })).toBe('flashed');
    expect(script).toContain('FlashWindow($ws, 4242, $true)');
    expect(await flashWindow('vi-voice', { platform: 'win32', run, hwnd: 'garbage' })).toBe('flashed');
    expect(script).toContain('FlashWindow($ws, 0, $true)');
  });
});

describe('attention: handle đã học phải là cửa sổ của workspace mình', () => {
  it('acceptLearnedWindow: tiêu đề đọc được phải có tên workspace (khi biết tên); mất focus giữa chừng thì bỏ', () => {
    const w = { hwnd: '66674', title: 'BillingPaymentService.cs - ACME-BE-HotFix (Workspace) - Visual Studio Code [Administrator]' };
    // Cửa sổ mới mở: extension đã "focused" nhưng OS còn để cửa sổ cũ ở foreground → đọc nhầm handle cửa sổ khác.
    expect(acceptLearnedWindow(w, 'role-permission-management (Workspace)', true)).toBe(false);
    expect(acceptLearnedWindow(w, 'ACME-BE-HotFix (Workspace)', true)).toBe(true);
    expect(acceptLearnedWindow(w, 'ACME-BE-HotFix (Workspace)', false)).toBe(false);
    // Không biết tên (cửa sổ không có folder) thì chỉ dựa vào focus.
    expect(acceptLearnedWindow(w, '', true)).toBe(true);
    // Hai cửa sổ trùng tên: tên khớp cả hai, focus quyết định (đó là lý do cần handle).
    expect(acceptLearnedWindow({ hwnd: '1', title: 'a.ts - Untitled (Workspace) - Visual Studio Code' }, 'Untitled (Workspace)', true)).toBe(true);
  });
  it('flashScript: handle chỉ được nháy khi tiêu đề của nó vẫn có tên workspace; sai thì tìm theo tên và báo handle cũ (mã +10)', () => {
    const s = flashScript('vi-voice', '4242');
    expect(s).toContain('TitleOf(known)');
    expect(s).toContain('stale = 10');
  });
  it('flashWindowEx: mã 10..13 là kết quả của tìm theo tên sau khi handle sai, kèm cờ staleHandle để extension học lại', async () => {
    const run = (code: number) => async () => code;
    expect(await flashWindowEx('vi-voice', { platform: 'win32', run: run(0), hwnd: '1' })).toEqual({ result: 'flashed', staleHandle: false });
    expect(await flashWindowEx('vi-voice', { platform: 'win32', run: run(10), hwnd: '1' })).toEqual({ result: 'flashed', staleHandle: true });
    expect(await flashWindowEx('vi-voice', { platform: 'win32', run: run(12), hwnd: '1' })).toEqual({ result: 'not-found', staleHandle: true });
    expect(await flashWindowEx('vi-voice', { platform: 'win32', run: run(13), hwnd: '1' })).toEqual({ result: 'foreground', staleHandle: true });
    expect(await flashWindow('vi-voice', { platform: 'win32', run: run(10), hwnd: '1' })).toBe('flashed');
  });
});

describe('attention: một tiến trình Windows Terminal chứa nhiều cửa sổ', () => {
  it('bước cây tiến trình ưu tiên cửa sổ có tiêu đề trùng tiêu đề console, không lấy cửa sổ trên cùng theo thứ tự Z', () => {
    // 30/9/2026: hai Claude CLI ở hai cửa sổ WT (một tiến trình WindowsTerminal.exe). Khi console không cho biết
    // cửa sổ chủ, bước cây tiến trình lấy cửa sổ đầu tiên EnumWindows trả về = cửa sổ đang nằm trên, tức cửa sổ
    // người dùng đang nhìn (B) chứ không phải cửa sổ của agent vừa xong (A).
    const s = flashHostScript(1, []);
    expect(s).toContain('GetConsoleTitle');
    expect(s).toContain('Titles[i] == ConsoleTitle');
  });
  it('script ghi cách chọn cửa sổ (console, tiêu đề, thứ tự Z) vào dòng log', () => {
    const s = flashHostScript(1, []);
    for (const how of ['[console]', '[title]', '[z-order]']) expect(s).toContain(how);
  });
  it('bỏ cửa sổ của explorer.exe cả khi explorer là con của một pid trong chuỗi, không chỉ khi nó là pid trong chuỗi', () => {
    // 1/10/2026: PowerShell mở từ Explorer (chuỗi ... ← powershell ← explorer ← userinit). Explorer bị bỏ qua khi
    // duyệt tới chính nó, nhưng khi duyệt tới cha của nó, luật "cửa sổ của con" nhận lại cửa sổ File Explorer và
    // hook nháy nhầm File Explorer thay vì báo không thấy.
    expect(NATIVE_SOURCE).toContain('if (ExeOf(wp) == "explorer.exe") continue;');
  });
});
