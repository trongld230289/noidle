import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';

/** Tiến trình play của hook không phát khi mic của một cửa sổ đang mở: chờ tới khi khoá mic được trả (tối đa VI_VOICE_MIC_WAIT_MS). */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-mic-'));
const bundle = path.join(work, 'claude-hook.js');
const tmp = path.join(work, 'tmp');
const lockFile = path.join(tmp, 'noidle-tts', 'windows', 'mic.lock');
const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
const noPlayer = path.join(work, 'no-such-player.exe');
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

function play(text: string): Promise<number | null> {
  const file = path.join(work, `say-${Date.now()}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, 'play', file, '--player', noPlayer, '--kind', 'notify', '--session', '-'], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, VI_VOICE_MIC_WAIT_MS: '800' },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

beforeAll(async () => {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  await build({ entryPoints: [path.join(__dirname, '..', 'src', 'hook.ts')], bundle: true, outfile: bundle, format: 'cjs', platform: 'node', target: 'node20', external: ['bufferutil', 'utf-8-validate'], logLevel: 'silent' });
}, 30_000);

describe('play waits for a free mic', () => {
  it('holds playback while a live window holds the mic, then gives up after the wait limit', async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const before = readLog().length;
    expect(await play('mic đang mở')).toBe(0);
    const added = readLog().slice(before);
    expect(added).toMatch(/mic vẫn mở sau (8|9|1\d)\d\dms, bỏ lượt phát/);
    expect(added).not.toContain('phát xong');
  });
  it('ignores a lock left by a dead window', async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now() }));
    const before = readLog().length;
    expect(await play('mic rảnh')).toBe(0);
    expect(readLog().slice(before)).not.toContain('đã chờ');
    fs.unlinkSync(lockFile);
  });
});
