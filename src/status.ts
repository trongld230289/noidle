import * as vscode from 'vscode';
import type { Lang } from './lang';
import { formatUsage, type ElevenUsage } from './elevenlabs';
import type { AttentionReason } from './signal';
import { idleStatus } from './statusText';

export type State = 'idle' | 'recording' | 'listening' | 'transcribing';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  private lang: Lang = 'vi';
  private state: State = 'idle';
  /** Agent đang được nghe (Claude hay Copilot), hiện ở trạng thái listening. */
  private agent = 'Claude';
  /** Status bar luôn tiếng Anh (UI của extension), không theo noIdle.language, vì đó là ngôn ngữ nói và nghe. */
  /** Cửa sổ này đang có việc cần người dùng (Claude xong, approve, trả lời); chỉ hiện khi rảnh, tắt khi cửa sổ được focus. */
  private attentionReason: AttentionReason | undefined;
  /** Không thấy ffplay: nút rảnh báo "no sound", bấm để cài ffmpeg. */
  private playerMissing = false;

  constructor() {
    this.item.command = 'noIdle.toggle';
    this.set('idle');
    this.item.show();
  }

  /** Thiếu hay có ffplay; hiện khi rảnh và không có việc cần người dùng. */
  missingPlayer(missing: boolean): void {
    if (this.playerMissing === missing) return;
    this.playerMissing = missing;
    if (this.state === 'idle') this.render();
  }

  /** Đổi màu status bar để tìm đúng cửa sổ trong nhiều cửa sổ; giữ tới khi clearAttention. */
  attention(reason: AttentionReason, lang: Lang = this.lang): void {
    this.attentionReason = reason;
    this.lang = lang;
    if (this.state === 'idle') this.render();
  }

  clearAttention(): void {
    if (!this.attentionReason) return;
    this.attentionReason = undefined;
    if (this.state === 'idle') this.render();
  }

  set(state: State, lang: Lang = this.lang, agent?: string): void {
    this.lang = lang;
    this.state = state;
    if (agent) this.agent = agent;
    this.render();
  }

  private render(): void {
    const state = this.state;
    // Lúc rảnh có thể đổi sang lệnh cài ffmpeg; các trạng thái khác luôn là bật/tắt mic.
    this.item.command = 'noIdle.toggle';
    switch (state) {
      case 'idle': {
        const s = idleStatus({ agent: this.agent, attention: this.attentionReason, missingPlayer: this.playerMissing });
        this.item.text = s.text;
        this.item.tooltip = s.tooltip;
        this.item.command = s.command;
        this.item.backgroundColor = s.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        break;
      }
      case 'recording':
        this.item.text = '$(record) Listening…';
        this.item.tooltip = 'F6 to stop';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'listening':
        this.item.text = `$(record) ${this.agent} is listening…`;
        this.item.tooltip = 'Say your next request, then press Enter. F6 turns the mic off';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
      case 'transcribing':
        this.item.text = '$(sync~spin) Transcribing…';
        this.item.tooltip = 'Sending to Groq';
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
