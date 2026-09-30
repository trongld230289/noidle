import { describe, it, expect } from 'vitest';
import { installCommand, afterInstallNote, installPlan, installLabel } from '../src/installTool';

describe('installCommand: lệnh cài ffmpeg / Node.js theo hệ điều hành', () => {
  it('Windows dùng winget với id gói, tự chấp nhận điều khoản', () => {
    expect(installCommand('ffmpeg', 'win32')).toBe('winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements');
    expect(installCommand('node', 'win32')).toBe('winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements');
  });
  it('macOS dùng brew', () => {
    expect(installCommand('ffmpeg', 'darwin')).toBe('brew install ffmpeg');
    expect(installCommand('node', 'darwin')).toBe('brew install node');
  });
  it('Linux không chạy giúp (mỗi distro một trình quản lý gói): undefined', () => {
    expect(installCommand('ffmpeg', 'linux')).toBeUndefined();
    expect(installCommand('node', 'linux')).toBeUndefined();
  });
});

describe('afterInstallNote: việc còn lại sau khi terminal cài đóng', () => {
  it('ffmpeg: extension tự tìm lại, không cần làm gì', () => {
    expect(afterInstallNote(['ffmpeg'])).toBeUndefined();
  });
  it('Node.js: VS Code đang chạy giữ PATH cũ, phải đóng hết cửa sổ rồi mở lại', () => {
    expect(afterInstallNote(['node'])).toMatch(/đóng hết.*VS Code.*mở lại/);
  });
});

describe('installPlan: thiếu cả hai thì một nút cài cả hai trong cùng một terminal', () => {
  it('Windows: hai lệnh winget, Node.js trước rồi ffmpeg', () => {
    expect(installPlan(['node', 'ffmpeg'], 'win32')).toEqual([
      'winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements',
      'winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements',
    ]);
    expect(installPlan(['ffmpeg'], 'darwin')).toEqual(['brew install ffmpeg']);
  });
  it('Linux: không chạy giúp, danh sách rỗng', () => {
    expect(installPlan(['node', 'ffmpeg'], 'linux')).toEqual([]);
  });
  it('nhãn nút và tên terminal gọi đúng tên các công cụ', () => {
    expect(installLabel(['node'])).toBe('Cài Node.js');
    expect(installLabel(['ffmpeg'])).toBe('Cài ffmpeg');
    expect(installLabel(['node', 'ffmpeg'])).toBe('Cài Node.js và ffmpeg');
  });
  it('có Node.js trong danh sách thì sau khi cài phải mở lại VS Code', () => {
    expect(afterInstallNote(['node', 'ffmpeg'])).toMatch(/đóng hết.*VS Code.*mở lại/);
    expect(afterInstallNote(['ffmpeg'])).toBeUndefined();
  });
});
