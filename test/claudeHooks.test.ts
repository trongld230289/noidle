import { describe, it, expect } from 'vitest';
import { hookCommands, applyHooks, copilotHooksFile, HookOptions } from '../src/claudeHooks';

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
  it('tạo file hook định dạng Copilot với Stop và UserPromptSubmit dùng cùng lệnh', () => {
    const file = copilotHooksFile(opts);
    const cmd = hookCommands(opts);
    expect(file.hooks.Stop).toEqual([{ type: 'command', command: `${cmd.Stop} --source copilot`, timeout: 60 }]);
    expect(file.hooks.UserPromptSubmit).toEqual([{ type: 'command', command: cmd.UserPromptSubmit }]);
    // Copilot không có PermissionRequest/AskUserQuestion nên không đăng ký notify.
    expect(Object.keys(file.hooks)).toEqual(['Stop', 'UserPromptSubmit']);
  });
});
