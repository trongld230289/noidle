import { describe, it, expect, vi } from 'vitest';
import { inject, InjectorApi } from '../src/injector';

function fakeApi(overrides: Partial<InjectorApi> = {}) {
  const sendText = vi.fn();
  const api: InjectorApi & { sendText: typeof sendText } = {
    sendText,
    activeTerminal: () => ({ sendText }),
    executeCommand: vi.fn(async () => undefined),
    writeClipboard: vi.fn(async () => undefined),
    readClipboard: vi.fn(async () => 'old'),
    pasteKeystroke: vi.fn(async () => undefined),
    ...overrides,
  };
  return api;
}

describe('inject', () => {
  it('terminal: sendText without newline', async () => {
    const api = fakeApi();
    expect(await inject('terminal', 'xin chào', api)).toBe('terminal');
    expect(api.sendText).toHaveBeenCalledWith('xin chào', false);
    expect(api.writeClipboard).not.toHaveBeenCalled();
  });

  it('terminal without active terminal falls back to paste', async () => {
    const api = fakeApi({ activeTerminal: () => undefined });
    expect(await inject('terminal', 'a', api)).toBe('paste');
    expect(api.writeClipboard).toHaveBeenNthCalledWith(1, 'a');
    expect(api.pasteKeystroke).toHaveBeenCalled();
  });

  it.each(['chat', 'editor'] as const)('%s: uses the type command', async (target) => {
    const api = fakeApi();
    expect(await inject(target, 'b', api)).toBe(target);
    expect(api.executeCommand).toHaveBeenCalledWith('type', { text: 'b' });
  });

  it('type command failure falls back to paste', async () => {
    const api = fakeApi({ executeCommand: vi.fn(async () => { throw new Error('no editor'); }) });
    expect(await inject('editor', 'c', api)).toBe('paste');
    expect(api.writeClipboard).toHaveBeenNthCalledWith(1, 'c');
  });

  it('clipboard target: copies, sends Ctrl+V, then restores old clipboard', async () => {
    const api = fakeApi();
    expect(await inject('clipboard', 'd', api)).toBe('paste');
    expect(api.writeClipboard).toHaveBeenNthCalledWith(1, 'd');
    expect(api.pasteKeystroke).toHaveBeenCalled();
    expect(api.writeClipboard).toHaveBeenNthCalledWith(2, 'old');
  });

  it('clipboard target: paste keystroke failure leaves text in clipboard', async () => {
    const api = fakeApi({ pasteKeystroke: vi.fn(async () => { throw new Error('no powershell'); }) });
    expect(await inject('clipboard', 'e', api)).toBe('clipboard');
    expect(api.writeClipboard).toHaveBeenCalledTimes(1);
    expect(api.writeClipboard).toHaveBeenCalledWith('e');
  });

  it('empty text does nothing', async () => {
    const api = fakeApi();
    expect(await inject('terminal', '', api)).toBe('terminal');
    expect(api.sendText).not.toHaveBeenCalled();
    expect(api.writeClipboard).not.toHaveBeenCalled();
  });
});
