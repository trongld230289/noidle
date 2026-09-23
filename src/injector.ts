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

export interface InjectOptions {
  /** Có giá trị thì gõ từng ký tự, nghỉ chừng này ms giữa các ký tự (hiệu ứng typing). */
  typeDelayMs?: number;
  /**
   * Terminal đã chốt từ lúc bắt đầu phiên nói. Không có thì lấy terminal đang active lúc chèn,
   * nhưng như vậy người dùng đổi terminal giữa chừng là cụm sau chạy sang cửa sổ khác.
   */
  terminal?: { sendText(text: string, addNewLine?: boolean): void };
  /**
   * Editor đã chốt từ lúc mở mic: chèn qua editor.edit tại con trỏ của nó, không qua lệnh `type` (đi vào chỗ đang focus).
   * insert trả false (editor đã đóng, edit bị từ chối) thì rơi xuống paste.
   */
  editor?: { insert(text: string): Thenable<boolean> };
  /**
   * Ô chat Copilot: toàn bộ transcript tính đến cụm này. Đặt vào ô chat bằng workbench.action.chat.open với
   * isPartialQuery (không gửi), không phụ thuộc ô chat có đang focus hay không. Gửi thì gọi cùng lệnh không có isPartialQuery.
   */
  chatText?: string;
}

/**
 * Chèn text vào đích. Terminal dùng sendText, chat/editor dùng lệnh `type`.
 * Mọi trường hợp còn lại (webview như panel Claude Code, hoặc đích lỗi): copy vào
 * clipboard, gửi Ctrl+V, rồi khôi phục clipboard cũ. Nếu không gửi được phím,
 * text vẫn nằm trong clipboard và trả về 'clipboard'.
 */
export async function inject(target: Target, text: string, api: InjectorApi, opts: InjectOptions = {}): Promise<Used> {
  if (!text) return target;
  const pieces = opts.typeDelayMs === undefined ? [text] : Array.from(text);
  const delay = opts.typeDelayMs ?? 0;
  try {
    if (target === 'terminal') {
      const terminal = opts.terminal ?? api.activeTerminal();
      if (!terminal) throw new Error('Không có terminal đang mở');
      await typeWith((p) => terminal.sendText(p, false), pieces, delay);
      return 'terminal';
    }
    if (target === 'editor' && opts.editor) {
      const editor = opts.editor;
      await typeWith(async (p) => {
        if (!(await editor.insert(p))) throw new Error('Editor không nhận edit');
      }, pieces, delay);
      return 'editor';
    }
    if (target === 'chat' && opts.chatText !== undefined) {
      await api.executeCommand('workbench.action.chat.open', { query: opts.chatText, isPartialQuery: true });
      return 'chat';
    }
    if (target === 'chat' || target === 'editor') {
      await typeWith((p) => api.executeCommand('type', { text: p }), pieces, delay);
      return target;
    }
  } catch {
    // rơi xuống paste
  }
  return pasteViaClipboard(text, api);
}

async function typeWith(send: (piece: string) => unknown, pieces: string[], delayMs: number): Promise<void> {
  for (let i = 0; i < pieces.length; i++) {
    await send(pieces[i]);
    if (delayMs > 0 && i < pieces.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
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
