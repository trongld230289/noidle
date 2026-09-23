import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { startServer, writeRegistry, type Signal } from '../src/signal';

/**
 * Tín hiệu listen của hook phải mang chuỗi pid tổ tiên của Claude Code, để extension tìm đúng terminal
 * đang chạy Claude thay vì lấy terminal đang focus. Ở đây hook là con của tiến trình test, nên chuỗi đó
 * phải chứa pid của test.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-term-'));
const bundle = path.join(work, 'claude-hook.js');
const tmp = path.join(work, 'tmp');
const windowsDir = path.join(tmp, 'noidle-tts', 'windows');
const cfg = path.join(work, 'handsfree.json');
const got: Signal[] = [];
let server: ReturnType<typeof startServer>;

function run(args: string[], stdin: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
    child.stdin.end(stdin);
  });
}

beforeAll(async () => {
  fs.mkdirSync(windowsDir, { recursive: true });
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
  fs.writeFileSync(cfg, JSON.stringify({ handsFree: true }));
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\noidle-term-${process.pid}-${Date.now()}`
      : path.join(os.tmpdir(), `vv-term-${process.pid}-${Date.now()}.sock`);
  server = startServer(pipe, (s) => void got.push(s));
  await new Promise((r) => server.once('listening', r));
  writeRegistry({ pid: 4242, pipe, folders: [work] }, windowsDir);
}, 30_000);

afterAll(() => server.close());

describe('listen signal carries the Claude process ancestry', () => {
  it('speak with nothing to read sends listen with ancestors containing the parent of the hook', async () => {
    const transcript = path.join(work, 'empty.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: '' } }));
    expect(await run(['speak', '--config', cfg], JSON.stringify({ session_id: 'term1', cwd: work, transcript_path: transcript }))).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    const listen = got.find((s) => s.event === 'listen');
    expect(listen).toBeTruthy();
    expect(listen?.ancestors).toContain(process.pid);
  }, 20_000);

  it('reuses the chain saved for the session on the next turn instead of querying the process table again', async () => {
    const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
    const transcript = path.join(work, 'empty.jsonl');
    // Một prompt xen giữa như thật: dấu phiên được ghi lại nhưng chuỗi pid đã lưu phải còn.
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: 'term1', cwd: work, prompt: 'làm tiếp đi' }));
    got.length = 0;
    const before = fs.readFileSync(logFile, 'utf8').length;
    expect(await run(['speak', '--config', cfg], JSON.stringify({ session_id: 'term1', cwd: work, transcript_path: transcript }))).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    const added = fs.readFileSync(logFile, 'utf8').slice(before);
    expect(added).toContain('proctree: dùng lại');
    expect(got.find((s) => s.event === 'listen')?.ancestors).toContain(process.pid);
  }, 20_000);
});

/**
 * Câu cũ đọc xong sau khi người dùng đã gửi prompt mới thì không được mở mic: Claude đang làm lượt mới,
 * mic mở lúc đó sẽ gõ tiếng nói vô tình vào terminal. Play mang số prompt của phiên lúc được tách ra và so lại trước khi ra hiệu.
 */
describe('a stale answer does not reopen the mic', () => {
  const noPlayer = path.join(work, 'no-such-player.exe');
  const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
  const session = 'stale1';
  function play(text: string, promptCount: number): Promise<number | null> {
    const file = path.join(work, `say-${Date.now()}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return run(['play', file, '--player', noPlayer, '--kind', 'speak', '--session', session, '--listen', work, '--prompt-count', String(promptCount)], '');
  }
  it('sends listen when no prompt was sent since the answer was produced', async () => {
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'câu hỏi một' }));
    got.length = 0;
    expect(await play('trả lời một', 1)).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.some((s) => s.event === 'listen' && s.session === session)).toBe(true);
  }, 40_000);
  it('skips listen when a newer prompt arrived while the answer was still playing', async () => {
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'câu hỏi hai' }));
    got.length = 0;
    const before = fs.readFileSync(logFile, 'utf8').length;
    expect(await play('trả lời một', 1)).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.some((s) => s.event === 'listen' && s.session === session)).toBe(false);
    expect(fs.readFileSync(logFile, 'utf8').slice(before)).toContain('prompt mới');
  }, 40_000);
});
