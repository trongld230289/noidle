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

describe('claude-hook pronunciations', () => {
  it('speak: thay thuật ngữ theo bảng mặc định và bảng trong config trước khi đọc', async () => {
    const cfg = path.join(work, 'pronounce.json');
    fs.writeFileSync(cfg, JSON.stringify({ pronunciations: { Claude: 'cờ lốt' } }));
    const transcript = path.join(work, 'transcript-pronounce.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '🔊 Claude đã đọc README.md và gọi API.' }] } }) + '\n',
    );
    const before = readLog().length;
    // --player trỏ tới file không tồn tại để tiến trình play tách ra không phát gì.
    const r = await run(
      ['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')],
      JSON.stringify({ session_id: 's4', cwd: work, transcript_path: transcript }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('cờ lốt đã đọc README chấm em đi và gọi ây pi ai.');
  });
});

describe('claude-hook prompt context per session', () => {
  const prompt = (session: string) => run(['prompt', '--config', cfgNormal], JSON.stringify({ session_id: session, cwd: work }));
  const ctx = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

  it('chèn hướng dẫn đầy đủ ở prompt đầu tiên của phiên, các prompt sau chỉ nhắc một dòng ngắn', async () => {
    const first = ctx((await prompt('ctx-a')).stdout);
    expect(first.length).toBeGreaterThan(500);
    expect(first).toContain('🔊');
    const second = ctx((await prompt('ctx-a')).stdout);
    expect(second.length).toBeLessThan(200);
    expect(second).toContain('🔊');
    const third = ctx((await prompt('ctx-a')).stdout);
    expect(third).toBe(second);
  });

  it('phiên khác thì lại chèn đầy đủ', async () => {
    await prompt('ctx-b');
    const other = ctx((await prompt('ctx-c')).stdout);
    expect(other.length).toBeGreaterThan(500);
  });

  it('không có session_id thì luôn chèn đầy đủ', async () => {
    const r = await run(['prompt', '--config', cfgNormal], JSON.stringify({ cwd: work }));
    expect(ctx(r.stdout).length).toBeGreaterThan(500);
    const r2 = await run(['prompt', '--config', cfgNormal], JSON.stringify({ cwd: work }));
    expect(ctx(r2.stdout).length).toBeGreaterThan(500);
  });
});
