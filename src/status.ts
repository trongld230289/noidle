import * as vscode from 'vscode';
import type { Lang } from './lang';

export type State = 'idle' | 'recording' | 'listening' | 'transcribing';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  private lang: Lang = 'vi';

  constructor() {
    this.item.command = 'noIdle.toggle';
    this.set('idle');
    this.item.show();
  }

  set(state: State, lang: Lang = this.lang): void {
    this.lang = lang;
    switch (state) {
      case 'idle':
        this.item.text = '$(mic) NoIdle';
        this.item.tooltip = 'F6 để bắt đầu nghe';
        this.item.backgroundColor = undefined;
        break;
      case 'recording':
        this.item.text = '$(record) Đang nghe…';
        this.item.tooltip = 'F6 để dừng';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'listening':
        // Trạng thái duy nhất người dùng tiếng Anh thấy khi rảnh tay, nên có bản tiếng Anh; các trạng thái khác để sau (nls).
        this.item.text = this.lang === 'en' ? '$(record) Claude is listening…' : '$(record) Claude đang nghe…';
        this.item.tooltip = this.lang === 'en' ? 'Say your next request, then press Enter. F6 turns the mic off' : 'Nói yêu cầu tiếp theo rồi bấm Enter. F6 để tắt mic';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'transcribing':
        this.item.text = '$(sync~spin) Đang chuyển chữ…';
        this.item.tooltip = 'Đang gửi lên Groq';
        this.item.backgroundColor = undefined;
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
