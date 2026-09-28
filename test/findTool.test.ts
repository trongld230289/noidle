import { describe, it, expect } from 'vitest';
import { findExecutable, parseRegistryPath, expandEnv, resolvePlayer, knownDirs } from '../src/findTool';

/**
 * Hook chạy dưới shell của người dùng, PATH của shell đó có thể cũ (PowerShell mở trước khi winget cài ffmpeg).
 * Extension tìm đường dẫn tuyệt đối theo PATH của mình, PATH trong registry (luôn mới) và các thư mục quen thuộc,
 * rồi ghi vào hook để chạy Claude từ shell nào cũng được.
 */
const win = (files: string[], extra: Partial<Parameters<typeof findExecutable>[1]> = {}) => ({
  platform: 'win32' as const,
  env: { PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', USERPROFILE: 'C:\\Users\\a' },
  exists: (p: string) => files.includes(p),
  registryPath: async () => [] as string[],
  ...extra,
});

describe('findExecutable', () => {
  it('finds a bare name in the process PATH, adding .exe on Windows', async () => {
    const deps = win(['C:\\Program Files\\nodejs\\node.exe']);
    expect(await findExecutable('node', deps)).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('falls back to the registry PATH when the process PATH is stale', async () => {
    const deps = win(['C:\\ffmpeg\\bin\\ffplay.exe'], { registryPath: async () => ['C:\\ffmpeg\\bin'] });
    expect(await findExecutable('ffplay', deps)).toBe('C:\\ffmpeg\\bin\\ffplay.exe');
  });

  it('falls back to the winget Links folder without any PATH entry', async () => {
    const deps = win(['C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffplay.exe']);
    expect(await findExecutable('ffplay', deps)).toBe('C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffplay.exe');
  });

  it('returns undefined when nothing exists', async () => {
    expect(await findExecutable('ffplay', win([]))).toBeUndefined();
  });

  it('keeps an absolute path only if it exists', async () => {
    expect(await findExecutable('C:\\x\\ffplay.exe', win(['C:\\x\\ffplay.exe']))).toBe('C:\\x\\ffplay.exe');
    expect(await findExecutable('C:\\x\\ffplay.exe', win([]))).toBeUndefined();
  });

  it('on macOS looks in Homebrew folders that a Dock-launched VS Code does not have in PATH', async () => {
    const deps = {
      platform: 'darwin' as const,
      env: { PATH: '/usr/bin:/bin' },
      exists: (p: string) => p === '/opt/homebrew/bin/ffplay',
      registryPath: async () => [],
    };
    expect(await findExecutable('ffplay', deps)).toBe('/opt/homebrew/bin/ffplay');
  });

  it('does not query the registry when the process PATH already has the tool', async () => {
    let queried = false;
    const deps = win(['C:\\Program Files\\nodejs\\node.exe'], {
      registryPath: async () => {
        queried = true;
        return [];
      },
    });
    await findExecutable('node', deps);
    expect(queried).toBe(false);
  });
});

describe('parseRegistryPath', () => {
  it('reads the Path value from reg query output and expands %VAR%', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\Microsoft\\WinGet\\Links;C:\\Users\\a\\bin;',
      '',
    ].join('\r\n');
    expect(parseRegistryPath(out, { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toEqual([
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links',
      'C:\\Users\\a\\bin',
    ]);
  });

  it('returns nothing for output without a Path value', () => {
    expect(parseRegistryPath('ERROR: The system was unable to find the specified registry key or value.', {})).toEqual([]);
  });

  it('expandEnv leaves unknown variables as they are', () => {
    expect(expandEnv('%NOPE%\\x', {})).toBe('%NOPE%\\x');
  });
});

describe('resolvePlayer (hook side)', () => {
  it('turns a bare ffplay into an absolute path when it can', async () => {
    const deps = win(['C:\\ffmpeg\\bin\\ffplay.exe'], { registryPath: async () => ['C:\\ffmpeg\\bin'] });
    expect(await resolvePlayer('ffplay', deps)).toBe('C:\\ffmpeg\\bin\\ffplay.exe');
  });

  it('keeps the value unchanged when nothing is found, so the spawn error still says ffplay', async () => {
    expect(await resolvePlayer('ffplay', win([]))).toBe('ffplay');
  });

  it('re-finds by basename when the saved absolute path no longer exists', async () => {
    const deps = win(['C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffplay.exe']);
    expect(await resolvePlayer('C:\\old\\ffplay.exe', deps)).toBe('C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffplay.exe');
  });

  it('uses a saved absolute path directly when it exists, no lookup', async () => {
    let queried = false;
    const deps = win(['C:\\x\\ffplay.exe'], {
      registryPath: async () => {
        queried = true;
        return [];
      },
    });
    expect(await resolvePlayer('C:\\x\\ffplay.exe', deps)).toBe('C:\\x\\ffplay.exe');
    expect(queried).toBe(false);
  });
});

describe('knownDirs', () => {
  it('lists winget, chocolatey, scoop and nodejs folders on Windows', () => {
    const dirs = knownDirs('win32', { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', ProgramData: 'C:\\PD', ProgramFiles: 'C:\\PF' });
    expect(dirs).toContain('C:\\L\\Microsoft\\WinGet\\Links');
    expect(dirs).toContain('C:\\PD\\chocolatey\\bin');
    expect(dirs).toContain('C:\\U\\scoop\\shims');
    expect(dirs).toContain('C:\\PF\\nodejs');
  });
});
