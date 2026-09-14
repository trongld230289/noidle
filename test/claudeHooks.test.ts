import { describe, it, expect } from 'vitest';
import { hookCommands, applyHooks, HookOptions } from '../src/claudeHooks';

const opts: HookOptions = {
  enabled: true,
  script: 'C:\\ext\\vi-voice\\dist\\claude-hook.js',
  voice: 'vi-VN-HoaiMyNeural',
  rate: '+0%',
  notify: true,
  player: 'ffplay',
  config: 'C:\\ext\\vi-voice\\hook-config.json',
};

describe('hookCommands', () => {
  it('mọi mode đều nhận --config để đọc cờ mute và hands-free lúc chạy', () => {
    const cmd = hookCommands(opts);
    for (const c of [cmd.Stop, cmd.UserPromptSubmit, cmd.Notify]) {
      expect(c).toContain('--config "C:/ext/vi-voice/hook-config.json"');
    }
  });
  it('không có config thì không thêm --config', () => {
    const cmd = hookCommands({ ...opts, config: undefined });
    expect(cmd.UserPromptSubmit).toBe('node "C:/ext/vi-voice/dist/claude-hook.js" prompt');
  });
});

describe('applyHooks', () => {
  it('thay hook cũ của vi-voice bằng lệnh mới', () => {
    const old = applyHooks({}, { ...opts, config: undefined });
    const next = applyHooks(old, opts);
    const prompt = next.hooks?.UserPromptSubmit?.flatMap((g) => g.hooks ?? []) ?? [];
    expect(prompt).toHaveLength(1);
    expect(prompt[0].command).toContain('--config');
  });
});
