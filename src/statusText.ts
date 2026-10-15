/**
 * Chữ, tooltip và lệnh của nút NoIdle trên status bar lúc rảnh. Tách khỏi status.ts (cần vscode) để test được.
 * Status bar luôn tiếng Anh (UI của extension), không theo noIdle.language.
 */
import type { AttentionReason } from './signal';

export interface IdleStatusInput {
  /** Agent vừa xong (Claude hay Copilot), dùng cho câu "X is done". */
  agent: string;
  /** Cửa sổ này đang có việc cần người dùng. */
  attention?: AttentionReason;
  /** Không thấy ffplay: hook chỉ nháy cửa sổ, không đọc thành tiếng. */
  missingPlayer?: boolean;
  /** Lượt đọc gần nhất không tải được giọng (xem voiceStatus.ts): lời khuyên cho người dùng. */
  voiceError?: string;
}

export interface IdleStatus {
  text: string;
  tooltip: string;
  command: string;
  /** Nền cảnh báo (vàng). */
  warning: boolean;
}

function attentionLabel(reason: AttentionReason, agent: string): string {
  return { done: `${agent} is done`, approve: 'needs approval', answer: 'needs your answer' }[reason];
}

/** Popup trên cửa sổ đang focus khi một cửa sổ VS Code khác cần người dùng (popup không vẽ codicon, nên không có icon). */
export function peerNotice(workspace: string, reason: AttentionReason, agent: string): string {
  return `${workspace}: ${attentionLabel(reason, agent)}`;
}

export function idleStatus(input: IdleStatusInput): IdleStatus {
  if (input.attention) {
    const label = attentionLabel(input.attention, input.agent);
    return { text: `$(bell-dot) ${label}`, tooltip: 'This window needs you. Clears when the window gets focus', command: 'noIdle.toggle', warning: true };
  }
  if (input.missingPlayer) {
    return {
      text: '$(mute) NoIdle: no sound',
      tooltip: 'ffplay not found: the window flashes but nothing is read aloud. Click to install ffmpeg',
      command: 'noIdle.installFfmpeg',
      warning: true,
    };
  }
  if (input.voiceError) {
    return {
      text: '$(mute) NoIdle: no voice',
      tooltip: `The last reply was not read aloud: ${input.voiceError}. Click to test the voice`,
      command: 'noIdle.testVoice',
      warning: true,
    };
  }
  return { text: '$(mic) NoIdle', tooltip: 'F6 to start listening', command: 'noIdle.toggle', warning: false };
}
