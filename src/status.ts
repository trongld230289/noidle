import * as vscode from 'vscode';

export type State = 'idle' | 'recording' | 'transcribing';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.item.command = 'viVoice.toggle';
    this.set('idle');
    this.item.show();
  }

  set(state: State): void {
    switch (state) {
      case 'idle':
        this.item.text = '$(mic) Vi Voice';
        this.item.tooltip = 'F6 để bắt đầu nghe';
        this.item.backgroundColor = undefined;
        break;
      case 'recording':
        this.item.text = '$(record) Đang nghe…';
        this.item.tooltip = 'F6 để dừng';
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
