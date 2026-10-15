import { describe, it, expect } from 'vitest';
import { idleStatus, peerNotice } from '../src/statusText';

describe('idleStatus: nút NoIdle trên status bar lúc rảnh', () => {
  it('bình thường: mic, bấm để nghe (F6)', () => {
    expect(idleStatus({ agent: 'Claude' })).toEqual({ text: '$(mic) NoIdle', tooltip: 'F6 to start listening', command: 'noIdle.toggle', warning: false });
  });
  it('thiếu ffplay: báo không có tiếng, bấm để cài ffmpeg, nền cảnh báo', () => {
    const s = idleStatus({ agent: 'Claude', missingPlayer: true });
    expect(s.text).toBe('$(mute) NoIdle: no sound');
    expect(s.tooltip).toMatch(/ffplay.*ffmpeg/i);
    expect(s.command).toBe('noIdle.installFfmpeg');
    expect(s.warning).toBe(true);
  });
  it('cửa sổ đang cần người dùng thì ưu tiên báo việc, kể cả khi thiếu ffplay', () => {
    const s = idleStatus({ agent: 'Copilot', missingPlayer: true, attention: 'done' });
    expect(s.text).toBe('$(bell-dot) Copilot is done');
    expect(s.command).toBe('noIdle.toggle');
    expect(s.warning).toBe(true);
    expect(idleStatus({ agent: 'Claude', attention: 'approve' }).text).toBe('$(bell-dot) needs approval');
    expect(idleStatus({ agent: 'Claude', attention: 'answer' }).text).toBe('$(bell-dot) needs your answer');
  });
  it('lượt đọc gần nhất không tải được giọng: báo no voice kèm lời khuyên, bấm để đọc thử, nền cảnh báo', () => {
    const s = idleStatus({ agent: 'Claude', voiceError: 'Your network re-signs HTTPS' });
    expect(s.text).toBe('$(mute) NoIdle: no voice');
    expect(s.tooltip).toContain('Your network re-signs HTTPS');
    expect(s.command).toBe('noIdle.testVoice');
    expect(s.warning).toBe(true);
  });
  it('thiếu ffplay quan trọng hơn lỗi tải giọng, việc cần người dùng quan trọng hơn cả hai', () => {
    expect(idleStatus({ agent: 'Claude', missingPlayer: true, voiceError: 'x' }).command).toBe('noIdle.installFfmpeg');
    expect(idleStatus({ agent: 'Claude', attention: 'done', voiceError: 'x' }).text).toBe('$(bell-dot) Claude is done');
  });
});

describe('peerNotice: cửa sổ đang focus báo cửa sổ VS Code khác cần người dùng', () => {
  it('ghi tên workspace và lý do', () => {
    expect(peerNotice('Research', 'done', 'Claude')).toBe('Research: Claude is done');
    expect(peerNotice('Research', 'approve', 'Copilot')).toBe('Research: needs approval');
    expect(peerNotice('Research', 'answer', 'Claude')).toBe('Research: needs your answer');
  });
});
