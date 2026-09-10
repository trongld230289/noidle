/** Đăng ký / gỡ hook của Vi Voice trong ~/.claude/settings.json của Claude Code. */

export const HOOK_MARK = 'claude-hook.js';

export interface HookOptions {
  enabled: boolean;
  /** Đường dẫn tuyệt đối tới dist/claude-hook.js của extension. */
  script: string;
  voice: string;
  rate: string;
  /** Đường dẫn ffplay (hoặc 'ffplay' để tìm trong PATH). */
  player: string;
}

interface HookCommand {
  type: string;
  command: string;
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

const q = (s: string) => `"${s.replace(/\\/g, '/')}"`;

/** Lệnh hook. Đường dẫn dùng dấu / để không phải escape trong JSON và chạy được cả cmd lẫn bash. */
export function hookCommands(o: HookOptions): { Stop: string; UserPromptSubmit: string } {
  const base = `node ${q(o.script)}`;
  return {
    Stop: `${base} speak --voice ${o.voice} --rate "${o.rate}" --player ${q(o.player)}`,
    UserPromptSubmit: `${base} prompt`,
  };
}

function isOurs(h: HookCommand): boolean {
  return typeof h.command === 'string' && h.command.includes(HOOK_MARK) && h.command.includes('vi-voice');
}

/** Trả về bản sao settings đã gỡ hook cũ của Vi Voice và (nếu enabled) thêm hook mới. */
export function applyHooks(settings: ClaudeSettings, o: HookOptions): ClaudeSettings {
  const out: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = out.hooks!;
  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (o.enabled) {
    const cmd = hookCommands(o);
    for (const event of ['Stop', 'UserPromptSubmit'] as const) {
      hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command: cmd[event] }] }];
    }
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}
