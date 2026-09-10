import { describe, it, expect } from 'vitest';
import { parseApproval, isDangerous } from '../src/decision';

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
