import { describe, it, expect } from 'vitest';
import { hookCommands, applyHooks, copilotHooksFile, copilotHookPaths, hooksEnabled, HookOptions } from '../src/claudeHooks';

const opts: HookOptions = {
  enabled: true,
  script: 'C:\\ext\\noidle\\dist\\claude-hook.js',
  voice: 'vi-VN-HoaiMyNeural',
  rate: '+0%',
  notify: true,
  player: 'ffplay',
  config: 'C:\\ext\\noidle\\hook-config.json',
};

describe('hookCommands', () => {
  it('mọi mode đều nhận --config để đọc cờ mute và hands-free lúc chạy', () => {
    const cmd = hookCommands(opts);
    for (const c of [cmd.Stop, cmd.UserPromptSubmit, cmd.Notify]) {
      expect(c).toContain('--config "C:/ext/noidle/hook-config.json"');
    }
  });
  it('không có config thì không thêm --config', () => {
    const cmd = hookCommands({ ...opts, config: undefined });
    expect(cmd.UserPromptSubmit).toBe('node "C:/ext/noidle/dist/claude-hook.js" prompt');
  });
});

describe('applyHooks', () => {
  it('gỡ hook của bản 1.x (đường dẫn extension vi-voice) khi đăng ký bản 2.0', () => {
    const legacy = applyHooks({}, { ...opts, script: 'C:\\Users\\a\\.vscode\\extensions\\trongld.vi-voice-1.11.0\\dist\\claude-hook.js' });
    const next = applyHooks(legacy, opts);
    const all = Object.values(next.hooks ?? {}).flat().flatMap((g) => g.hooks ?? []);
    expect(all.some((h) => h.command.includes('vi-voice'))).toBe(false);
    expect(all.some((h) => h.command.includes('noidle'))).toBe(true);
  });

  it('thay hook cũ của noidle bằng lệnh mới', () => {
    const old = applyHooks({}, { ...opts, config: undefined });
    const next = applyHooks(old, opts);
    const prompt = next.hooks?.UserPromptSubmit?.flatMap((g) => g.hooks ?? []) ?? [];
    expect(prompt).toHaveLength(1);
    expect(prompt[0].command).toContain('--config');
  });
});

describe('copilotHooksFile', () => {
  it('registers one versioned shared file with camelCase events only', () => {
    const file = copilotHooksFile(opts);
    const cmd = hookCommands(opts);
    expect(file.version).toBe(1);
    expect(file.hooks.sessionStart).toEqual([
      { type: 'command', command: 'node "C:/ext/noidle/dist/claude-hook.js" start --config "C:/ext/noidle/hook-config.json" --source copilot' },
    ]);
    expect(file.hooks.agentStop).toEqual([{ type: 'command', command: `${cmd.Stop} --source copilot`, timeoutSec: 60 }]);
    expect(file.hooks.userPromptSubmitted).toEqual([{ type: 'command', command: `${cmd.UserPromptSubmit} --source copilot` }]);
    expect(Object.keys(file.hooks).sort()).toEqual([
      'agentStop', 'notification', 'permissionRequest', 'preToolUse', 'sessionStart', 'userPromptSubmitted',
    ]);
    expect(file.hooks.userPromptTransformed).toBeUndefined();
  });

  it('registers shared pre-tool handling and CLI permission notifications with explicit events', () => {
    const file = copilotHooksFile(opts);
    const cmd = hookCommands(opts);
    expect(file.hooks.permissionRequest).toEqual([
      { type: 'command', command: `${cmd.Notify} --event PermissionRequest --source copilot`, timeoutSec: 120 },
    ]);
    expect(file.hooks.preToolUse).toEqual([
      { type: 'command', command: `${cmd.Notify} --event PreToolUse --source copilot`, timeoutSec: 180 },
    ]);
    expect(file.hooks.notification).toEqual([
      { type: 'command', command: `${cmd.Notify} --event Notification --source copilot` },
    ]);
  });

  it('gates all notification events without disabling lifecycle hooks', () => {
    expect(Object.keys(copilotHooksFile({ ...opts, notify: false }).hooks).sort()).toEqual([
      'agentStop', 'sessionStart', 'userPromptSubmitted',
    ]);
  });

  it('quotes config and script paths with spaces in every shared hook command', () => {
    const file = copilotHooksFile({ ...opts, script: 'C:\\My Extension\\claude-hook.js', config: 'D:\\My Config\\hook.json' });
    for (const hooks of Object.values(file.hooks)) {
      expect(hooks).toHaveLength(1);
      expect(hooks[0].command).toContain('node "C:/My Extension/claude-hook.js"');
      expect(hooks[0].command).toContain('--config "D:/My Config/hook.json"');
      expect(hooks[0].command).toContain('--source copilot');
      expect(hooks[0]).not.toHaveProperty('timeout');
    }
  });

  it('omits the optional config flag from every command', () => {
    const file = copilotHooksFile({ ...opts, config: undefined });
    for (const hooks of Object.values(file.hooks)) expect(hooks[0].command).not.toContain('--config');
    expect(file.hooks.sessionStart[0].command).toBe('node "C:/ext/noidle/dist/claude-hook.js" start --source copilot');
  });

  it('does not change Claude hook names, matchers, timeouts or sources', () => {
    const file = applyHooks({}, opts);
    expect(file.hooks?.Stop?.[0].hooks?.[0]).toEqual({ type: 'command', command: hookCommands(opts).Stop, timeout: 60 });
    expect(file.hooks?.PreToolUse?.[0].matcher).toBe('AskUserQuestion');
    expect(file.hooks?.PermissionRequest?.[0].hooks?.[0].timeout).toBe(120);
    expect(JSON.stringify(file)).not.toContain('--source');
    expect(file.hooks?.sessionStart).toBeUndefined();
  });
});

describe('copilotHookPaths', () => {
  it('always includes the shared default file, even with a custom CLI home', () => {
    expect(copilotHookPaths('C:\\Users\\Alice', 'D:\\CLI Home')).toEqual([
      'C:\\Users\\Alice\\.copilot\\hooks\\noidle.json', 'D:\\CLI Home\\hooks\\noidle.json',
    ]);
  });

  it.each([undefined, '', '   '])('ignores an absent or blank custom home: %s', (home) => {
    expect(copilotHookPaths('C:\\Users\\Alice', home)).toEqual(['C:\\Users\\Alice\\.copilot\\hooks\\noidle.json']);
  });

  it.each(['c:\\users\\ALICE\\.COPILOT\\', 'C:/Users/Alice/.copilot', 'C:\\Users\\Alice\\.copilot\\nested\\..'])(
    'deduplicates equivalent Windows paths: %s', (home) => {
      expect(copilotHookPaths('C:\\Users\\Alice', home)).toEqual(['C:\\Users\\Alice\\.copilot\\hooks\\noidle.json']);
    },
  );

  it('preserves UNC paths and deduplicates their casing', () => {
    expect(copilotHookPaths('\\\\server\\share\\Alice', '\\\\SERVER\\SHARE\\Alice\\.copilot')).toEqual([
      '\\\\server\\share\\Alice\\.copilot\\hooks\\noidle.json',
    ]);
  });
});

describe('hooksEnabled', () => {
  it('hook được cài khi còn bất kỳ tính năng nào cần nó: đọc, nháy taskbar hoặc đổi màu', () => {
    const off = { voiceResponse: false, attentionFlash: false, attentionColor: false };
    expect(hooksEnabled(off)).toBe(false);
    expect(hooksEnabled({ ...off, voiceResponse: true })).toBe(true);
    expect(hooksEnabled({ ...off, attentionFlash: true })).toBe(true);
    expect(hooksEnabled({ ...off, attentionColor: true })).toBe(true);
  });
});
