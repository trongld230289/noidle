/**
 * Cài giúp ffmpeg (tiếng đọc, ghi âm) và Node.js (chạy hook) bằng winget hay brew trong terminal của VS Code.
 * Tách khỏi extension.ts để test được. Linux mỗi distro một trình quản lý gói nên chỉ hướng dẫn, không chạy giúp.
 */
export type Tool = 'ffmpeg' | 'node';

const COMMANDS: Record<Tool, { win32: string; darwin: string }> = {
  ffmpeg: {
    win32: 'winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements',
    darwin: 'brew install ffmpeg',
  },
  node: {
    win32: 'winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements',
    darwin: 'brew install node',
  },
};

export const TOOL_LABEL: Record<Tool, string> = { ffmpeg: 'ffmpeg', node: 'Node.js' };

/** Lệnh cài cho hệ điều hành này; undefined khi không chạy giúp được (Linux, hệ khác). */
export function installCommand(tool: Tool, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32' || platform === 'darwin') return COMMANDS[tool][platform];
  return undefined;
}

/** Gợi ý cài tay cho Linux. */
export function manualHint(tool: Tool): string {
  return tool === 'node'
    ? 'NoIdle: cài Node.js bằng trình quản lý gói (ví dụ: sudo apt install nodejs npm), rồi đóng hết VS Code và mở lại.'
    : 'NoIdle: cài ffmpeg bằng trình quản lý gói (ví dụ: sudo apt install ffmpeg), rồi đổi một setting NoIdle bất kỳ để extension tìm lại.';
}

/**
 * Việc còn lại sau khi terminal cài đóng. ffmpeg: extension tự tìm lại đường dẫn (kể cả registry PATH) và đồng bộ
 * hook. Node.js: VS Code và Copilot Chat đang chạy giữ PATH cũ nên hook vẫn không thấy node tới khi mở lại VS Code.
 */
export function afterInstallNote(tool: Tool): string | undefined {
  return tool === 'node' ? 'NoIdle: cài Node.js xong thì đóng hết cửa sổ VS Code rồi mở lại để hook chạy được.' : undefined;
}
