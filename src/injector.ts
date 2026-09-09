export type Target = 'terminal' | 'chat' | 'editor' | 'clipboard';

export interface InjectorApi {
  activeTerminal(): { sendText(text: string, addNewLine?: boolean): void } | undefined;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  writeClipboard(text: string): Thenable<void>;
}

/** Chèn text vào đích; nếu đích không dùng được thì copy vào clipboard. Trả về đích thực sự đã dùng. */
export async function inject(target: Target, text: string, api: InjectorApi): Promise<Target> {
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
    // rơi xuống clipboard
  }
  await api.writeClipboard(text);
  return 'clipboard';
}
