import { describe, it, expect } from 'vitest';
import { parseApproval, isDangerous, parseChoice, parseVoiceCommand } from '../src/decision';

describe('parseChoice', () => {
  const labels = ['Lưới tuần kiểu bảng tính', 'Dòng thời gian kiểu lịch', 'Nhật ký kiểu chat'];
  it('understands numbers, number words and letters', () => {
    expect(parseChoice('chọn 2', labels)).toEqual([1]);
    expect(parseChoice('lựa chọn thứ ba', labels)).toEqual([2]);
    expect(parseChoice('một và ba', labels)).toEqual([0, 2]);
    expect(parseChoice('b', labels)).toEqual([1]);
    expect(parseChoice('chọn số 5', labels)).toBeUndefined();
  });
  it('matches option labels by name, with or without diacritics', () => {
    expect(parseChoice('lấy cái kiểu chat đi', labels)).toEqual([2]);
    expect(parseChoice('luoi tuan kieu bang tinh', labels)).toEqual([0]);
    expect(parseChoice('dòng thời gian kiểu lịch với nhật ký kiểu chat', labels)).toEqual([1, 2]);
  });
  it('handles all, skip and nonsense', () => {
    expect(parseChoice('tất cả', labels)).toEqual([0, 1, 2]);
    expect(parseChoice('thôi bỏ qua', labels)).toEqual([]);
    expect(parseChoice('hôm nay trời đẹp', labels)).toBeUndefined();
    expect(parseChoice('', labels)).toBeUndefined();
  });
});

describe('parseApproval', () => {
  it('recognises approvals in Vietnamese and English, with or without diacritics', () => {
    for (const t of ['Approve', 'đồng ý', 'dong y nhe', 'OK làm đi', 'Cho phép.', 'Duyệt', 'ừ, tiếp tục đi', 'Được']) {
      expect(parseApproval(t)).toBe('allow');
    }
  });
  it('recognises denials and prefers deny when both appear', () => {
    for (const t of ['Từ chối', 'không', 'Không đồng ý', 'dừng lại', 'huỷ đi', 'no', 'thôi']) {
      expect(parseApproval(t)).toBe('deny');
    }
    expect(parseApproval('không, đừng approve')).toBe('deny');
  });
  it('returns undefined for unrelated speech or silence', () => {
    expect(parseApproval('')).toBeUndefined();
    expect(parseApproval('hôm nay trời đẹp')).toBeUndefined();
    expect(parseApproval('okela')).toBeUndefined();
  });
});

describe('isDangerous', () => {
  it('flags destructive shell commands', () => {
    for (const c of ['rm -rf dist', 'git push origin main', 'git reset --hard HEAD~1', 'Remove-Item -Recurse -Force node_modules', 'DROP TABLE users', 'del /s /q build', 'docker system prune', 'sudo apt install x']) {
      expect(isDangerous('Bash', { command: c })).toBe(true);
    }
  });
  it('allows ordinary commands and edits', () => {
    expect(isDangerous('Bash', { command: 'npm test' })).toBe(false);
    expect(isDangerous('Bash', { command: 'git status && git diff' })).toBe(false);
    expect(isDangerous('Edit', { file_path: 'src/a.ts' })).toBe(false);
    expect(isDangerous('WebFetch', { url: 'https://x' })).toBe(false);
  });
  it('flags edits to secrets and settings files', () => {
    expect(isDangerous('Write', { file_path: 'C:/app/.env' })).toBe(true);
    expect(isDangerous('Edit', { file_path: '/home/u/.claude/settings.json' })).toBe(true);
  });
});

describe('parseVoiceCommand', () => {
  it('gửi ở cuối câu: bỏ từ đó, lệnh send', () => {
    expect(parseVoiceCommand('sửa lỗi này gửi')).toEqual({ command: 'send', text: 'sửa lỗi này' });
    expect(parseVoiceCommand('Gửi đi.')).toEqual({ command: 'send', text: '' });
    expect(parseVoiceCommand('chạy test, send')).toEqual({ command: 'send', text: 'chạy test' });
  });
  it('chỉ một từ huỷ/thôi/dừng: lệnh cancel', () => {
    for (const w of ['huỷ', 'Hủy.', 'thôi', 'bỏ', 'dừng', 'xong']) expect(parseVoiceCommand(w).command).toBe('cancel');
  });
  it('câu thường: không lệnh, giữ nguyên chữ', () => {
    expect(parseVoiceCommand('gửi email cho khách')).toEqual({ text: 'gửi email cho khách' });
    expect(parseVoiceCommand('thôi không cần refactor')).toEqual({ text: 'thôi không cần refactor' });
    expect(parseVoiceCommand('đọc lại bản gửi')).toEqual({ command: 'send', text: 'đọc lại bản' });
  });
});
