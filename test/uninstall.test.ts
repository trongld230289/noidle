import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyHooks, copilotHooksFile, type HookOptions } from '../src/claudeHooks';
import { removeNoIdleHooks } from '../src/uninstall';

const opts: HookOptions = {
  enabled: true,
  script: 'C:\\Users\\a\\AppData\\Roaming\\Code\\User\\globalStorage\\trongld232.noidle\\claude-hook.js',
  voice: 'vi-VN-HoaiMyNeural',
  rate: '+0%',
  notify: true,
  player: 'ffplay',
  config: 'C:\\Users\\a\\AppData\\Roaming\\Code\\User\\globalStorage\\trongld232.noidle\\hook-config.json',
};

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-uninstall-'));
}

function write(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

describe('removeNoIdleHooks (vscode:uninstall)', () => {
  it('deletes the Copilot hook file but keeps other hook files', () => {
    const h = home();
    const ours = path.join(h, '.copilot', 'hooks', 'noidle.json');
    const other = path.join(h, '.copilot', 'hooks', 'other.json');
    write(ours, copilotHooksFile(opts));
    write(other, { version: 1, hooks: {} });
    removeNoIdleHooks(h, undefined);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('also deletes the copy under COPILOT_HOME', () => {
    const h = home();
    const custom = path.join(h, 'custom-copilot');
    const copy = path.join(custom, 'hooks', 'noidle.json');
    write(copy, copilotHooksFile(opts));
    removeNoIdleHooks(h, custom);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('strips NoIdle from Claude settings and keeps everything else', () => {
    const h = home();
    const claude = path.join(h, '.claude', 'settings.json');
    const mine = { type: 'command', command: 'echo mine' };
    write(claude, applyHooks({ model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } }, opts));
    removeNoIdleHooks(h, undefined);
    const after = JSON.parse(fs.readFileSync(claude, 'utf8'));
    expect(after.model).toBe('opus');
    expect(JSON.stringify(after)).not.toContain('claude-hook.js');
    expect(after.hooks.Stop).toEqual([{ hooks: [mine] }]);
  });

  it('leaves an unreadable Claude settings file untouched', () => {
    const h = home();
    const claude = path.join(h, '.claude', 'settings.json');
    write(claude, '{ not json');
    removeNoIdleHooks(h, undefined);
    expect(fs.readFileSync(claude, 'utf8')).toBe('{ not json');
  });

  it('does nothing when no hooks were ever installed', () => {
    const h = home();
    expect(() => removeNoIdleHooks(h, undefined)).not.toThrow();
    expect(fs.existsSync(path.join(h, '.claude'))).toBe(false);
  });
});
