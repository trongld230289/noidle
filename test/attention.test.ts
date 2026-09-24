import { describe, it, expect } from 'vitest';
import { windowTitleMatches, flashScript, flashWindow, applyTint, removeTint, TINT } from '../src/attention';

describe('attention: tìm cửa sổ VS Code theo tiêu đề', () => {
  it('khớp tiêu đề mặc định "file - workspace - Visual Studio Code"', () => {
    expect(windowTitleMatches('● hook.ts - vi-voice - Visual Studio Code', 'vi-voice')).toBe(true);
    expect(windowTitleMatches('vi-voice - Visual Studio Code', 'vi-voice')).toBe(true);
    expect(windowTitleMatches('README.md - vi-voice - Visual Studio Code - Insiders', 'vi-voice')).toBe(true);
  });
  it('không khớp workspace khác, tên chỉ là một phần của tên khác, hay app khác', () => {
    expect(windowTitleMatches('main.go - shipngo-be - Visual Studio Code', 'vi-voice')).toBe(false);
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
});

describe('attention: script PowerShell nháy taskbar', () => {
  it('gọi FlashWindowEx với cờ FLASHW_ALL | FLASHW_TIMERNOFG và tên workspace đã escape', () => {
    const s = flashScript("vi-voice's");
    expect(s).toContain('FlashWindowEx');
    expect(s).toContain('dwFlags = 15');
    expect(s).toContain("'vi-voice''s'");
    expect(s).toContain('GetForegroundWindow');
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

describe('attention: tô màu title bar qua workbench.colorCustomizations', () => {
  it('applyTint thêm màu title bar, nhớ giá trị cũ của đúng các khoá đó', () => {
    const { next, saved } = applyTint({ 'editor.background': '#111', 'titleBar.activeBackground': '#abc' });
    expect(next['editor.background']).toBe('#111');
    expect(next['titleBar.activeBackground']).toBe(TINT.activeBackground);
    expect(next['titleBar.inactiveBackground']).toBe(TINT.inactiveBackground);
    expect(next['titleBar.activeForeground']).toBe(TINT.foreground);
    expect(saved).toEqual({ 'titleBar.activeBackground': '#abc' });
  });
  it('removeTint trả lại giá trị cũ, xoá khoá mình thêm, không đụng khoá khác; rỗng thì undefined', () => {
    const { next, saved } = applyTint({ 'editor.background': '#111', 'titleBar.activeBackground': '#abc' });
    expect(removeTint(next, saved)).toEqual({ 'editor.background': '#111', 'titleBar.activeBackground': '#abc' });
    expect(removeTint(applyTint(undefined).next, {})).toBeUndefined();
  });
  it('removeTint không ghi đè màu người dùng đã đổi trong lúc đang tô', () => {
    const { next, saved } = applyTint({});
    const edited = { ...next, 'titleBar.activeBackground': '#123456' };
    expect(removeTint(edited, saved)).toEqual({ 'titleBar.activeBackground': '#123456' });
  });
});
