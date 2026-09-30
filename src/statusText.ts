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
}

export interface IdleStatus {
  text: string;
  tooltip: string;
  command: string;
  /** Nền cảnh báo (vàng). */
  warning: boolean;
}

export function idleStatus(input: IdleStatusInput): IdleStatus {
  if (input.attention) {
    const label = { done: `${input.agent} is done`, approve: 'needs approval', answer: 'needs your answer' }[input.attention];
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
  return { text: '$(mic) NoIdle', tooltip: 'F6 to start listening', command: 'noIdle.toggle', warning: false };
}
