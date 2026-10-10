import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { writeRegistry } from '../src/signal';

/**
 * Copilot CLI (và phiên Copilot trên Agent Host của VS Code) coi preToolUse thoát khác 0 là lỗi và từ chối tool đó
 * ("Denied by preToolUse hook (hook errored)"); VS Code Local coi exit 2 là lỗi chặn. Hook chỉ để đọc và nháy cửa sổ,
 * nên mọi đường lỗi phải thoát 0.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-failopen-'));
const bundle = path.join(work, 'claude-hook.js');
const tmp = path.join(work, 'tmp');

function run(args: string[], stdin = ''): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, VI_VOICE_HOST_FLASH: '0' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
    child.stdin.end(stdin);
  });
}

beforeAll(async () => {
  fs.mkdirSync(tmp, { recursive: true });
  await build({ entryPoints: [path.join(__dirname, '..', 'src', 'hook.ts')], bundle: true, outfile: bundle, format: 'cjs', platform: 'node', target: 'node20', external: ['bufferutil', 'utf-8-validate'], logLevel: 'silent' });
}, 30_000);

describe('hook never fails the agent', () => {
  it('exits 0 for a mode it does not know (hook file from another NoIdle version)', async () => {
    expect(await run(['some-future-mode', '--source', 'copilot'])).toBe(0);
  });

  it('exits 0 when the agent sends input it cannot parse', async () => {
    expect(await run(['notify', '--event', 'PreToolUse', '--source', 'copilot'], '{ not json')).toBe(0);
  });
});

describe.runIf(process.platform === 'win32')('hook does not outlive its work', () => {
  it('exits promptly when a window pipe is busy (libuv would wait 30 s in WaitNamedPipe)', async () => {
    const name = `noidle-busy-${process.pid}`;
    // Một instance duy nhất, tự nối một client vào: client khác nối tới gặp ERROR_PIPE_BUSY như cửa sổ đang reload.
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object System.IO.Pipes.NamedPipeServerStream('${name}', [System.IO.Pipes.PipeDirection]::InOut, 1); ` +
      `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}'); $c.Connect(); $s.WaitForConnection(); ` +
      `[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    try {
      await new Promise<void>((resolve) => holder.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve()));
      const cwd = path.join(work, 'proj');
      writeRegistry({ pid: process.pid, pipe: `\\\\.\\pipe\\${name}`, folders: [cwd] }, path.join(tmp, 'noidle-tts', 'windows'));
      const t0 = Date.now();
      expect(await run(['prompt'], JSON.stringify({ prompt: 'hello', cwd, session_id: 'busy-test' }))).toBe(0);
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      holder.kill();
    }
  });
});
