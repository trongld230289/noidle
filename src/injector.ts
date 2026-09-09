export type Target = 'terminal' | 'chat' | 'editor' | 'clipboard';
/** Đích thực sự đã dùng: 'paste' = đã dán bằng Ctrl+V vào cửa sổ đang focus. */
export type Used = Target | 'paste';

export interface InjectorApi {
  activeTerminal(): { sendText(text: string, addNewLine?: boolean): void } | undefined;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  writeClipboard(text: string): Thenable<void>;
  readClipboard(): Thenable<string>;
  /** Gửi tổ hợp Ctrl+V vào cửa sổ đang focus (OS-level). */
  pasteKeystroke(): Promise<void>;
}

/**
 * Chèn text vào đích. Terminal dùng sendText, chat/editor dùng lệnh `type`.
 * Mọi trường hợp còn lại (webview như panel Claude Code, hoặc đích lỗi): copy vào
 * clipboard, gửi Ctrl+V, rồi khôi phục clipboard cũ. Nếu không gửi được phím,
 * text vẫn nằm trong clipboard và trả về 'clipboard'.
 */
export async function inject(target: Target, text: string, api: InjectorApi): Promise<Used> {
  if (!text) return target;
  try {
    if (target === 'terminal') {
      const terminal = api.activeTerminal();
      if (!terminal) throw new Error('Không có terminal đang mở');
      terminal.sendText(text, false);
      return 'terminal';
    }
    if (target === 'chat' || target === 'editor') {
      await api.executeCommand('type', { text });
      return target;
    }
  } catch {
    // rơi xuống paste
  }
  return pasteViaClipboard(text, api);
}

async function pasteViaClipboard(text: string, api: InjectorApi): Promise<Used> {
  let previous: string | undefined;
  try {
    previous = await api.readClipboard();
  } catch {
    previous = undefined;
  }
  await api.writeClipboard(text);
  try {
    await api.pasteKeystroke();
  } catch {
    return 'clipboard';
  }
  if (previous !== undefined) {
    // Chờ ứng dụng đích đọc clipboard xong rồi mới trả lại nội dung cũ.
    await new Promise((r) => setTimeout(r, 300));
    await api.writeClipboard(previous);
  }
  return 'paste';
}
