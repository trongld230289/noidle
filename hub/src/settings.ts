/** Thêm / gỡ hook của hub trong ~/.claude/settings.json. Chỉ đụng hook có dấu HOOK_MARK, hook khác giữ nguyên. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const HOOK_MARK = 'vi-voice-hub';

export type HookEvent = 'UserPromptSubmit' | 'Stop' | 'PermissionRequest' | 'PreToolUse' | 'Notification';

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [k: string]: unknown;
}
export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export function claudeSettingsPath(): string {
  return path.join(process.env.VI_VOICE_HUB_CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'settings.json');
}

/**
 * Lệnh cho từng sự kiện. Đường dẫn dùng dấu / để khỏi escape và chạy được cả cmd lẫn bash.
 * Cờ --vi-voice-hub ở cuối là dấu nhận diện để uninstall gỡ đúng hook của mình dù cài ở đường dẫn nào; hook bỏ qua cờ này.
 */
export function hookCommands(script: string): Record<HookEvent, { command: string; matcher?: string; timeout?: number }> {
  const p = script.replace(/\\/g, '/');
  const cmd = (event: HookEvent) => `node "${p}" hook ${event} --${HOOK_MARK}`;
  return {
    UserPromptSubmit: { command: cmd('UserPromptSubmit') },
    Stop: { command: cmd('Stop'), timeout: 30 },
    PermissionRequest: { command: cmd('PermissionRequest'), timeout: 120 },
    PreToolUse: { command: cmd('PreToolUse'), matcher: 'AskUserQuestion', timeout: 180 },
    Notification: { command: cmd('Notification'), matcher: 'elicitation_dialog' },
  };
}

const isOurs = (h: HookCommand) => typeof h.command === 'string' && h.command.includes(`--${HOOK_MARK}`) && h.command.includes(' hook ');

/** Bản sao settings đã gỡ hook của hub, rồi thêm lại nếu enabled. */
export function applyHooks(settings: ClaudeSettings, script: string, enabled: boolean): ClaudeSettings {
  const out: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = out.hooks!;
  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (enabled) {
    const cmds = hookCommands(script);
    for (const event of Object.keys(cmds) as HookEvent[]) {
      const { command, matcher, timeout } = cmds[event];
      const hook: HookCommand = { type: 'command', command };
      if (timeout) hook.timeout = timeout;
      const group: HookGroup = { hooks: [hook] };
      if (matcher) group.matcher = matcher;
      hooks[event] = [...(hooks[event] ?? []), group];
    }
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

/** Đọc, sửa, ghi settings.json; giữ bản sao .bak trước khi ghi. */
export function updateClaudeSettings(script: string, enabled: boolean): string {
  const p = claudeSettingsPath();
  let current: ClaudeSettings = {};
  try {
    current = JSON.parse(fs.readFileSync(p, 'utf8')) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`không đọc được ${p}: ${(err as Error).message}`);
  }
  const next = applyHooks(current, script, enabled);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak`);
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return p;
}
