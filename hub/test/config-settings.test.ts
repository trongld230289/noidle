import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configPath, loadConfig, saveConfig, ensureConfig } from '../src/config';
import { applyHooks, hookCommands, HOOK_MARK } from '../src/settings';

describe('config', () => {
  beforeEach(() => {
    process.env.VI_VOICE_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-'));
  });
  it('defaults without writing when the file is missing', () => {
    const c = loadConfig();
    expect(c).toMatchObject({ enabled: false, port: 4319, lan: false, waitSec: 90, lang: 'vi' });
    expect(c.token).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.existsSync(configPath())).toBe(false);
  });
  it('ensureConfig creates the file enabled and keeps the token afterwards', () => {
    const a = ensureConfig();
    expect(a.enabled).toBe(true);
    expect(fs.existsSync(configPath())).toBe(true);
    const b = loadConfig();
    expect(b.token).toBe(a.token);
    saveConfig({ ...b, lan: true, port: 5000 });
    expect(loadConfig()).toMatchObject({ lan: true, port: 5000, token: a.token });
  });
  it('tolerates a broken file and fills missing fields', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '{"port": "x", "lang": "en"}');
    expect(loadConfig()).toMatchObject({ port: 4319, lang: 'en' });
    fs.writeFileSync(configPath(), 'garbage');
    expect(loadConfig().enabled).toBe(false);
  });
});

describe('settings hooks', () => {
  const script = 'C:\\Users\\me\\hub\\dist\\hub.js';
  it('builds commands with forward slashes and the marker', () => {
    const cmd = hookCommands(script);
    expect(cmd.Stop.command).toBe('node "C:/Users/me/hub/dist/hub.js" hook Stop --vi-voice-hub');
    expect(cmd.Stop.command).toContain(HOOK_MARK);
    expect(cmd.PreToolUse.matcher).toBe('AskUserQuestion');
    expect(cmd.Notification.matcher).toBe('elicitation_dialog');
    expect(cmd.PermissionRequest.timeout).toBe(120);
  });
  it('adds hooks next to existing ones and removes only its own on disable', () => {
    const other = { type: 'command', command: 'node "x/claude-hook.js" speak' };
    const settings = { theme: 'dark', hooks: { Stop: [{ hooks: [other] }] } };
    const on = applyHooks(settings, script, true);
    const h = on.hooks!;
    expect(on.theme).toBe('dark');
    expect(h.Stop).toHaveLength(2);
    expect(h.Stop[0].hooks![0]).toEqual(other);
    expect(h.Stop[1].hooks![0].command).toContain(HOOK_MARK);
    expect(h.UserPromptSubmit).toHaveLength(1);
    expect(h.PreToolUse[0].matcher).toBe('AskUserQuestion');
    // Bật lại lần nữa không nhân đôi.
    const again = applyHooks(on, script, true);
    expect(again.hooks!.Stop).toHaveLength(2);
    const off = applyHooks(again, script, false);
    expect(off.hooks!.Stop).toEqual([{ hooks: [other] }]);
    expect(off.hooks!.UserPromptSubmit).toBeUndefined();
    expect(off.hooks!.PreToolUse).toBeUndefined();
  });
  it('works on empty settings and cleans up the hooks key', () => {
    const on = applyHooks({}, script, true);
    expect(Object.keys(on.hooks!).sort()).toEqual(['Notification', 'PermissionRequest', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    expect(applyHooks(on, script, false)).toEqual({});
  });
});
