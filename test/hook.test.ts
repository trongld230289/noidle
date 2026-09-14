import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';

/**
 * Chạy hook thật (bundle như dist/claude-hook.js) với TEMP riêng để không đụng registry cửa sổ
 * và log của máy thật. Log của hook nằm ở <TEMP>/vi-voice-tts/hook.log.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-voice-hook-test-'));
const bundle = path.join(work, 'claude-hook.js');
const cfgMuted = path.join(work, 'muted.json');
const cfgNormal = path.join(work, 'normal.json');
const logFile = path.join(work, 'tmp', 'vi-voice-tts', 'hook.log');

function run(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(work, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

beforeAll(async () => {
  await build({
    entryPoints: [path.join(__dirname, '..', 'src', 'hook.ts')],
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'silent',
  });
  fs.writeFileSync(cfgMuted, JSON.stringify({ voiceMute: true, handsFree: true }));
  fs.writeFileSync(cfgNormal, JSON.stringify({ voiceMute: false, handsFree: false }));
}, 30_000);

describe('claude-hook voiceMute', () => {
  it('prompt: không mute thì chèn hướng dẫn 🔊 cho Claude', async () => {
    const r = await run(['prompt', '--config', cfgNormal], JSON.stringify({ session_id: 's1', cwd: work }));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(out.hookSpecificOutput?.additionalContext).toContain('🔊');
  });

  it('prompt: mute thì không chèn gì, Claude trả lời như thường', async () => {
    const r = await run(['prompt', '--config', cfgMuted], JSON.stringify({ session_id: 's1', cwd: work }));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('speak: mute thì không tách tiến trình play và không gửi tín hiệu listen', async () => {
    const transcript = path.join(work, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong.\n🔊 Đã xong việc.' }] } }) + '\n',
    );
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgMuted], JSON.stringify({ session_id: 's2', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('mute');
    expect(added).not.toContain('play pid');
    expect(added).not.toContain('listen');
  });

  it('notify: mute thì im lặng, không tách tiến trình play', async () => {
    const before = readLog().length;
    const r = await run(
      ['notify', '--config', cfgMuted],
      JSON.stringify({ session_id: 's3', cwd: work, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('mute');
    expect(added).not.toContain('play pid');
  });
});
