import * as vscode from 'vscode';
import type { Lang } from './lang';
import { formatUsage, type ElevenUsage } from './elevenlabs';

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

/** Credit ElevenLabs còn lại, cạnh nút mic; chỉ hiện khi đang dùng ElevenLabs. Hook ghi số liệu ra file sau mỗi lượt đọc. */
export class UsageBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);

  constructor() {
    this.item.command = 'noIdle.testVoice';
  }

  update(u: ElevenUsage | undefined): void {
    if (!u) {
      this.item.hide();
      return;
    }
    const left = Math.max(0, u.limit - u.used);
    this.item.text = `$(megaphone) ${formatUsage(u)}`;
    const reset = u.resetAt ? `, reset ${new Date(u.resetAt).toLocaleDateString('vi-VN')}` : '';
    this.item.tooltip = `ElevenLabs (${u.tier || '?'}): còn ${left.toLocaleString('vi-VN')} / ${u.limit.toLocaleString('vi-VN')} credit${reset}. Cập nhật sau mỗi lượt đọc. Bấm để đọc thử.`;
    this.item.backgroundColor = left < u.limit * 0.1 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
