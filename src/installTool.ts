/**
 * Cài giúp ffmpeg (tiếng đọc, ghi âm) và Node.js (chạy hook) bằng winget hay brew trong terminal của VS Code.
 * Máy mới thường thiếu cả hai: một nút cài cả hai trong cùng một terminal, không bắt người dùng đi hai vòng cảnh báo.
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

/** Các lệnh chạy lần lượt trong một terminal, theo thứ tự truyền vào; rỗng khi không chạy giúp được. */
export function installPlan(tools: Tool[], platform: NodeJS.Platform = process.platform): string[] {
  const cmds = tools.map((t) => installCommand(t, platform));
  return cmds.every((c): c is string => !!c) ? cmds : [];
}

const names = (tools: Tool[]): string => tools.map((t) => TOOL_LABEL[t]).join(' và ');

/** Nhãn nút trên cảnh báo và tên terminal: "Cài Node.js và ffmpeg". */
export function installLabel(tools: Tool[]): string {
  return `Cài ${names(tools)}`;
}

/** Gợi ý cài tay cho Linux. */
export function manualHint(tools: Tool[]): string {
  const pkgs = tools.map((t) => (t === 'node' ? 'nodejs npm' : 'ffmpeg')).join(' ');
  const after = tools.includes('node') ? 'đóng hết VS Code và mở lại' : 'đổi một setting NoIdle bất kỳ để extension tìm lại';
  return `NoIdle: cài ${names(tools)} bằng trình quản lý gói (ví dụ: sudo apt install ${pkgs}), rồi ${after}.`;
}

/**
 * Việc còn lại sau khi terminal cài đóng. ffmpeg: extension tự tìm lại đường dẫn (kể cả registry PATH) và đồng bộ
 * hook. Node.js: VS Code và Copilot Chat đang chạy giữ PATH cũ nên hook vẫn không thấy node tới khi mở lại VS Code.
 */
export function afterInstallNote(tools: Tool[]): string | undefined {
  return tools.includes('node') ? `NoIdle: cài ${names(tools)} xong thì đóng hết cửa sổ VS Code rồi mở lại để hook chạy được.` : undefined;
}
