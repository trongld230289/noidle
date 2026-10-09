/**
 * vscode:uninstall: VS Code chạy file này bằng Node (không có API vscode) khi NoIdle bị gỡ hẳn, ở lần khởi động lại sau đó.
 * Gỡ extension không xoá hook đã ghi cho Copilot (~/.copilot/hooks/noidle.json) và Claude Code (~/.claude/settings.json):
 * hook mồ côi vẫn chạy node ở mỗi lượt, vẫn đọc nếu script còn trong globalStorage, và người dùng phải tự xoá tay.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyHooks, copilotHookPaths, type ClaudeSettings } from './claudeHooks';

export function removeNoIdleHooks(home: string = os.homedir(), copilotHome: string | undefined = process.env.COPILOT_HOME): void {
  for (const file of copilotHookPaths(home, copilotHome)) fs.rmSync(file, { force: true });
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(fs.readFileSync(claudeSettings, 'utf8')) as ClaudeSettings;
  } catch {
    // Không có file, hoặc file người dùng đang sửa dở: không ghi đè.
    return;
  }
  const next = applyHooks(settings, { enabled: false, script: '', voice: '', rate: '', notify: false, player: '' });
  if (JSON.stringify(next) !== JSON.stringify(settings)) {
    fs.writeFileSync(claudeSettings, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
}

if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
  try {
    removeNoIdleHooks();
  } catch {
    /* gỡ cài đặt không được làm VS Code báo lỗi */
  }
}
