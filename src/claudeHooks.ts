/** Đăng ký / gỡ hook của NoIdle trong ~/.claude/settings.json của Claude Code. */

import * as path from 'path';

export const HOOK_MARK = 'claude-hook.js';

export interface HookOptions {
  enabled: boolean;
  /** Đường dẫn tuyệt đối tới dist/claude-hook.js của extension. */
  script: string;
  voice: string;
  rate: string;
  /** Đọc thông báo khi Claude cần approve hoặc có câu hỏi. */
  notify: boolean;
  /** Đường dẫn ffplay (hoặc 'ffplay' để tìm trong PATH). */
  player: string;
  /** File cấu hình JSON extension ghi ra cho hook (key, mic, ffmpeg...). */
  config?: string;
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
export function hookCommands(o: HookOptions): { Stop: string; UserPromptSubmit: string; Notify: string } {
  const base = `node ${q(o.script)}`;
  const configArg = o.config ? ` --config ${q(o.config)}` : '';
  const voiceArgs = `--voice ${o.voice} --rate "${o.rate}" --player ${q(o.player)}` + configArg;
  return {
    Stop: `${base} speak ${voiceArgs}`,
    // prompt cũng cần config để biết đang mute mà không chèn hướng dẫn 🔊.
    UserPromptSubmit: `${base} prompt${configArg}`,
    Notify: `${base} notify ${voiceArgs}`,
  };
}

/**
 * Sự kiện cần báo bằng giọng. PermissionRequest bắn ngay lúc hộp thoại xin quyền hiện và có tên tool,
 * còn Notification permission_prompt chỉ bắn sau ~6 giây nên không dùng để khỏi báo hai lần.
 * elicitation_dialog là form của MCP server chờ người dùng.
 */
export const NOTIFY_EVENTS: { event: string; matcher?: string; timeout?: number }[] = [
  // Approve bằng giọng: đọc thông báo rồi nghe vài chục giây, nên nới timeout.
  { event: 'PermissionRequest', timeout: 120 },
  { event: 'PreToolUse', matcher: 'AskUserQuestion', timeout: 180 },
  { event: 'Notification', matcher: 'elicitation_dialog' },
];

/** Hook của mình: đường dẫn script nằm trong thư mục extension noidle, hoặc vi-voice (tên cũ trước 2.0, gỡ khi đồng bộ). */
function isOurs(h: HookCommand): boolean {
  return typeof h.command === 'string' && h.command.includes(HOOK_MARK) && (h.command.includes('noidle') || h.command.includes('vi-voice'));
}

/** Shared by Copilot CLI and Chat: aliases must appear only once to avoid duplicate speech. */
export function copilotHooksFile(o: HookOptions): { version: 1; hooks: Record<string, HookCommand[]> } {
  const cmd = hookCommands(o);
  const configArg = o.config ? ` --config ${q(o.config)}` : '';
  const hooks: Record<string, HookCommand[]> = {
    sessionStart: [{ type: 'command', command: `node ${q(o.script)} start${configArg} --source copilot` }],
    userPromptSubmitted: [{ type: 'command', command: `${cmd.UserPromptSubmit} --source copilot` }],
    agentStop: [{ type: 'command', command: `${cmd.Stop} --source copilot`, timeoutSec: 60 }],
  };
  if (o.notify) {
    hooks.permissionRequest = [{ type: 'command', command: `${cmd.Notify} --event PermissionRequest --source copilot`, timeoutSec: 120 }];
    hooks.preToolUse = [{ type: 'command', command: `${cmd.Notify} --event PreToolUse --source copilot`, timeoutSec: 180 }];
    // The handler filters notification types, including actual permission prompts.
    hooks.notification = [{ type: 'command', command: `${cmd.Notify} --event Notification --source copilot` }];
  }
  return { version: 1, hooks };
}

export function copilotHookPaths(home: string, copilotHome?: string): string[] {
  const paths = [path.join(home, '.copilot', 'hooks', 'noidle.json')];
  if (copilotHome?.trim()) {
    const custom = path.join(copilotHome, 'hooks', 'noidle.json');
    const comparable = (p: string) => path.win32.normalize(p).toLowerCase();
    if (comparable(custom) !== comparable(paths[0])) paths.push(custom);
  }
  return paths;
}

/** Trả về bản sao settings đã gỡ hook cũ của NoIdle và (nếu enabled) thêm hook mới. */
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
      const hook: HookCommand = { type: 'command', command: cmd[event] };
      // Stop: đọc câu trả lời được tách sang tiến trình play, hook chỉ chờ tách xong; 60s là dư.
      if (event === 'Stop') hook.timeout = 60;
      hooks[event] = [...(hooks[event] ?? []), { hooks: [hook] }];
    }
    if (o.notify) {
      for (const { event, matcher, timeout } of NOTIFY_EVENTS) {
        const hook: HookCommand = { type: 'command', command: cmd.Notify };
        if (timeout) hook.timeout = timeout;
        const group: HookGroup = { hooks: [hook] };
        if (matcher) group.matcher = matcher;
        hooks[event] = [...(hooks[event] ?? []), group];
      }
    }
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

/**
 * Hook được cài khi còn tính năng nào cần nó: đọc (voiceResponse), mic tự mở (handsFree), nháy taskbar (attentionFlash) hoặc đổi màu
 * (attentionColor). Từng tính năng bật/tắt lúc chạy qua hook-config, nên chỉ lúc tắt hết mới gỡ hook.
 */
export function hooksEnabled(s: { voiceResponse: boolean; handsFree?: boolean; attentionFlash: boolean; attentionColor: boolean }): boolean {
  return s.voiceResponse || s.handsFree === true || s.attentionFlash || s.attentionColor;
}
