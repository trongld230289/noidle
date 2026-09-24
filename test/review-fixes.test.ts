import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseApproval, isDangerous, permissionRequestOutput } from '../src/decision';
import { inject, InjectorApi } from '../src/injector';
import { hookCommands, copilotHooksFile, HookOptions } from '../src/claudeHooks';
import { parseSignal, acquireMic, releaseMic, micHolder } from '../src/signal';
import { Segmenter } from '../src/segmenter';

/** Sửa theo review 22/9/2026: approve quá rộng, lọc lệnh nguy hiểm lọt, schema PermissionRequest sai, gửi nhầm terminal, mic chung nhiều cửa sổ. */

describe('parseApproval only accepts clear confirmations', () => {
  it('treats negated approvals as deny', () => {
    for (const t of ['do not approve', "don't approve", 'not okay', 'never mind, no', 'không được approve', 'đừng ok']) {
      expect(parseApproval(t)).toBe('deny');
    }
  });
  it('leaves deferrals and hedges to the manual dialog', () => {
    for (const t of ['approve later', 'ok wait', 'để sau', 'khoan đã', 'hold on', 'chưa']) {
      expect(parseApproval(t)).toBeUndefined();
    }
  });
  it('still accepts plain confirmations', () => {
    for (const t of ['approve', 'ok', 'yes', 'đồng ý', 'ừ, tiếp tục đi']) expect(parseApproval(t)).toBe('allow');
  });
});

describe('isDangerous covers flag and path variants', () => {
  it('flags git subcommands with options before the verb', () => {
    for (const c of ['git -C repo push', 'git --no-pager push origin main', 'git -C x reset --hard', 'git -c a=b clean -fd', 'git -C repo branch -D old']) {
      expect(isDangerous('Bash', { command: c })).toBe(true);
    }
  });
  it('flags recursive or forced deletes with long flags', () => {
    for (const c of ['rm --recursive --force dist', 'rm -R build', 'rm --force -r build', 'rm --recursive out']) {
      expect(isDangerous('Bash', { command: c })).toBe(true);
    }
  });
  it('flags env variants and other secret files', () => {
    for (const f of ['C:/app/.env.production', '/srv/.env.local', '/home/u/.npmrc', '/home/u/.ssh/id_rsa', 'C:/app/appsettings.Production.json']) {
      expect(isDangerous('Edit', { file_path: f })).toBe(true);
    }
    expect(isDangerous('Edit', { file_path: 'src/environment.ts' })).toBe(false);
  });
});

describe('permissionRequestOutput uses the documented PermissionRequest schema', () => {
  it('allow: decision.behavior allow', () => {
    expect(permissionRequestOutput('allow', 'User approved by voice: "yes"')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  it('deny: decision.behavior deny with the reason as message', () => {
    expect(permissionRequestOutput('deny', 'User denied by voice: "no"')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'User denied by voice: "no"' } },
    });
  });
});

function fakeApi(overrides: Partial<InjectorApi> = {}) {
  const sendText = vi.fn();
  return {
    sendText,
    activeTerminal: () => ({ sendText }),
    executeCommand: vi.fn(async () => undefined),
    writeClipboard: vi.fn(async () => undefined),
    readClipboard: vi.fn(async () => 'old'),
    pasteKeystroke: vi.fn(async () => undefined),
    ...overrides,
  } as InjectorApi & { sendText: ReturnType<typeof vi.fn> };
}

describe('inject with a pinned terminal', () => {
  it('sends to the terminal given in options even when focus moved to another one', async () => {
    const pinned = { sendText: vi.fn() };
    const api = fakeApi();
    expect(await inject('terminal', 'xin chào', api, { terminal: pinned })).toBe('terminal');
    expect(pinned.sendText).toHaveBeenCalledWith('xin chào', false);
    expect(api.sendText).not.toHaveBeenCalled();
  });
  it('falls back to the active terminal when no terminal is pinned', async () => {
    const api = fakeApi();
    expect(await inject('terminal', 'a', api)).toBe('terminal');
    expect(api.sendText).toHaveBeenCalledWith('a', false);
  });
});

describe('Copilot hooks tell the hook where the answer came from', () => {
  const opts: HookOptions = { enabled: true, script: 'C:/x/claude-hook.js', voice: 'v', rate: '+0%', notify: true, player: 'ffplay', config: 'C:/x/c.json' };
  it('adds --source copilot to the shared agentStop command but not Claude Stop', () => {
    const copilot = copilotHooksFile(opts).hooks.agentStop[0].command;
    expect(copilot).toContain('--source copilot');
    expect(hookCommands(opts).Stop).not.toContain('--source');
  });
});

describe('parseSignal keeps the source', () => {
  it('passes source through and ignores unknown values', () => {
    expect(parseSignal('{"event":"listen","session":"s","cwd":"D:/x","source":"copilot"}')).toEqual({ event: 'listen', session: 's', cwd: 'D:/x', source: 'copilot' });
    expect(parseSignal('{"event":"listen","session":"s","cwd":"D:/x","source":"weird"}')).toEqual({ event: 'listen', session: 's', cwd: 'D:/x' });
  });
});

describe('mic lock shared across VS Code windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-mic-lock-'));
  it('first window takes the mic, a second live window is refused, release frees it', () => {
    expect(acquireMic(process.pid, dir)).toBe(true);
    expect(micHolder(dir)).toBe(process.pid);
    expect(acquireMic(process.pid + 1, dir, () => true)).toBe(false);
    // Cùng cửa sổ lấy lại thì được (F6 rồi hook ask trong cùng pid không xảy ra, nhưng không được tự khoá mình).
    expect(acquireMic(process.pid, dir)).toBe(true);
    releaseMic(process.pid, dir);
    expect(micHolder(dir)).toBeUndefined();
    expect(acquireMic(process.pid + 1, dir, () => true)).toBe(true);
    releaseMic(process.pid + 1, dir);
  });
  it('ignores a lock left by a dead window or older than the max age', () => {
    fs.writeFileSync(path.join(dir, 'mic.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
    expect(acquireMic(process.pid, dir, () => false)).toBe(true);
    releaseMic(process.pid, dir);
    fs.writeFileSync(path.join(dir, 'mic.lock'), JSON.stringify({ pid: process.pid + 2, at: Date.now() - 10 * 60_000 }));
    expect(acquireMic(process.pid, dir, () => true)).toBe(true);
    releaseMic(process.pid, dir);
  });
  it('release by a window that does not hold the lock is a no-op', () => {
    expect(acquireMic(process.pid, dir)).toBe(true);
    releaseMic(process.pid + 5, dir);
    expect(micHolder(dir)).toBe(process.pid);
    releaseMic(process.pid, dir);
  });
});

describe('Segmenter reports speech activity', () => {
  const RATE = 16000;
  function pcm(ms: number, amplitude: number): Uint8Array {
    const n = Math.round((RATE * ms) / 1000);
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE));
    return new Uint8Array(samples.buffer);
  }
  it('calls onSpeech for loud frames and not for silence', () => {
    let calls = 0;
    const seg = new Segmenter({ sampleRate: RATE, onSpeech: () => calls++ }, () => undefined);
    seg.push(pcm(500, 0));
    expect(calls).toBe(0);
    // Khung 20ms, chỉ báo khi ồn liền mạch từ 120ms: 300ms ồn báo ở các khung từ thứ 6 tới 15.
    seg.push(pcm(300, 8000));
    expect(calls).toBe(10);
    seg.push(pcm(600, 0));
    expect(calls).toBe(10);
  });
});
