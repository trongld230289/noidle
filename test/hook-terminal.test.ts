import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { startServer, writeRegistry, removeRegistry, type Signal } from '../src/signal';

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
const playedAudio = path.join(work, 'played-audio.jsonl');
const got: Signal[] = [];
let server: ReturnType<typeof startServer>;

function run(args: string[], stdin: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // Không bao giờ phát ra loa thật trong test: speak/notify thiếu --player thì dùng player giả (2026-09-29 test đỏ từng đọc to).
    if (['speak', 'notify'].includes(args[0]) && !args.includes('--player')) args = [...args, '--player', path.join(work, 'no-such-player.exe')];
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
    plugins: [{
      name: 'offline-audio',
      setup(builder) {
        builder.onResolve({ filter: /^msedge-tts$/ }, () => ({ path: 'tts', namespace: 'offline' }));
        builder.onLoad({ filter: /^tts$/, namespace: 'offline' }, () => ({
          contents: `
            const { Readable } = require('stream');
            exports.OUTPUT_FORMAT = { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' };
            exports.MsEdgeTTS = class {
              async setMetadata() {}
              toStream(text) {
                if (!text.includes('force-tts-failure')) return { audioStream: Readable.from([Buffer.from(text)]) };
                // Như mạng công ty ký lại HTTPS mà node không tin: câu nào cũng lỗi chứng chỉ.
                const audioStream = new Readable({ read() {} });
                setImmediate(() => audioStream.destroy(new Error('Edge TTS WebSocket error: unable to get local issuer certificate (code=UNABLE_TO_GET_ISSUER_CERT_LOCALLY)')));
                return { audioStream };
              }
              close() {}
            };
          `,
        }));
        builder.onResolve({ filter: /^child_process$/ }, () => ({ path: 'process', namespace: 'offline' }));
        builder.onLoad({ filter: /^process$/, namespace: 'offline' }, () => ({
          contents: `
            const childProcess = require('node:child_process');
            module.exports = {
              ...childProcess,
              spawn(command, args, options) {
                if (command === process.execPath && args[0] === '-nodisp') {
                  const capture = ${JSON.stringify(`
                    let audio = '';
                    process.stdin.on('data', chunk => { audio += chunk.toString(); });
                    process.stdin.on('end', () => {
                      if (audio.includes('force-player-failure')) {
                        process.stderr.write('test audio device is unavailable');
                        process.exitCode = 2;
                        return;
                      }
                      require('fs').appendFileSync(${JSON.stringify(playedAudio)}, JSON.stringify(audio) + '\\n');
                    });
                  `)};
                  return childProcess.spawn(command, ['-e', capture], options);
                }
                return childProcess.spawn(command, args, options);
              },
            };
          `,
        }));
      },
    }],
  });
  // Lần chạy đầu của bundle mới trên Windows chậm vài giây (Defender quét file): làm nóng ở đây để test đầu không timeout.
  await run(['skip'], '');
  fs.writeFileSync(cfg, JSON.stringify({ handsFree: true }));
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\noidle-term-${process.pid}-${Date.now()}`
      : path.join(os.tmpdir(), `vv-term-${process.pid}-${Date.now()}.sock`);
  server = startServer(pipe, (s) => {
    // Như extension thật: hook là con của tiến trình test, nên pid test nằm trong chuỗi → cửa sổ này chứa agent.
    if (s.event === 'probe') return s.ancestors?.includes(process.pid) ? 'owned' : 'no';
    got.push(s);
  });
  await new Promise((r) => server.once('listening', r));
  // pid của chính tiến trình test: registry dọn pid chết trước khi gửi attention, cửa sổ giả phải còn sống.
  writeRegistry({ pid: process.pid, pipe, folders: [work] }, windowsDir);
}, 30_000);

afterAll(() => server.close());

/** Chạy hook qua một shell trung gian như Claude Code thật (bash -c / cmd /c): ppid của hook là shell tạm, không phải tiến trình test. */
function runWrapped(args: string[], stdin: string): Promise<number | null> {
  const cmd = [process.execPath, bundle, ...args, '--player', path.join(work, 'no-such-player.exe')].map((a) => `"${a}"`).join(' ');
  const [sh, shArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `"${cmd}"`]] : ['sh', ['-c', cmd]];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, shArgs, {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsVerbatimArguments: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
    child.stdin.end(stdin);
  });
}

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

  it('reuses the chain saved for the session on the next turn, even though each hook runs under a fresh wrapper shell', async () => {
    // 3/10/2026: Claude Code chạy hook qua bash -c → bash → node, ppid của hook là shell tạm nên cache khoá theo ppid
    // không bao giờ trúng (0/827 lần trong log thật). Neo phải là tiến trình agent (ở đây: tiến trình test).
    const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
    const transcript = path.join(work, 'empty.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: '' } }));
    got.length = 0;
    expect(await runWrapped(['speak', '--config', cfg], JSON.stringify({ session_id: 'term2', cwd: work, transcript_path: transcript }))).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.find((s) => s.event === 'listen')?.ancestors?.[0]).toBe(process.pid);
    // Một prompt xen giữa như thật: dấu phiên được ghi lại nhưng chuỗi pid đã lưu phải còn.
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: 'term2', cwd: work, prompt: 'làm tiếp đi' }));
    got.length = 0;
    const before = fs.readFileSync(logFile, 'utf8').length;
    expect(await runWrapped(['speak', '--config', cfg], JSON.stringify({ session_id: 'term2', cwd: work, transcript_path: transcript }))).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(logFile, 'utf8').slice(before)).toContain('proctree: dùng lại');
    expect(got.find((s) => s.event === 'listen')?.ancestors?.[0]).toBe(process.pid);
  }, 40_000);
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

describe('standalone Claude playback after VS Code closes', () => {
  const standaloneConfig = path.join(work, 'standalone.json');
  const transcript = path.join(work, 'standalone.jsonl');
  const captured = () => fs.existsSync(playedAudio)
    ? fs.readFileSync(playedAudio, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string)
    : [];

  it('continues delivering audio after IPC closes, with a stale registry and after registry cleanup', async () => {
    fs.writeFileSync(standaloneConfig, JSON.stringify({ language: 'en', handsFree: true }));
    const speak = async (text: string) => {
      const before = captured().length;
      fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: text } }));
      const input = { session_id: 'standalone', cwd: work, transcript_path: transcript };
      expect(await run(['speak', '--config', standaloneConfig, '--player', process.execPath], JSON.stringify(input))).toBe(0);
      await vi.waitFor(() => expect(captured().slice(before)).toEqual([text]), { timeout: 10_000 });
      await vi.waitFor(() => {
        const queue = path.join(tmp, 'noidle-tts', 'queue');
        const pending = fs.readdirSync(queue).filter((file) => file.endsWith('.json'));
        expect(pending).toEqual([]);
      }, { timeout: 10_000 });
    };

    await speak('The first standalone reply plays while the extension IPC server is available.');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await speak('The next standalone reply must still play when the extension IPC server has stopped.');
    removeRegistry(process.pid, windowsDir);
    await speak('The final standalone reply must still play with no registered editor window at all.');
  }, 40_000);

  it('reports player failure instead of claiming playback completed', async () => {
    const textFile = path.join(work, 'player-failure.txt');
    const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
    fs.writeFileSync(textFile, 'force-player-failure');
    const before = fs.readFileSync(logFile, 'utf8').length;
    expect(await run(['play', textFile, '--player', process.execPath], '')).toBe(0);
    const added = fs.readFileSync(logFile, 'utf8').slice(before);
    expect(added).toContain('player exited with code 2');
    expect(added).toContain('test audio device is unavailable');
    expect(added).not.toContain('phát xong');
  });

  // 15/10/2026: mọi câu lỗi chứng chỉ mà log vẫn ghi "phát xong", không báo gì lên VS Code; người dùng tưởng loa hỏng.
  it('says no sentence could be read when every sentence fails, records it for the status bar, and clears it once the voice works', async () => {
    const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
    const statusFile = path.join(tmp, 'noidle-tts', 'voice-status.json');
    const failing = path.join(work, 'tts-failure.txt');
    fs.writeFileSync(failing, 'force-tts-failure one. force-tts-failure two.');
    const before = fs.readFileSync(logFile, 'utf8').length;
    expect(await run(['play', failing, '--player', process.execPath], '')).toBe(0);
    const added = fs.readFileSync(logFile, 'utf8').slice(before);
    expect(added).toContain('không đọc được câu nào');
    expect(added).not.toContain('phát xong');
    const failed = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(failed.hint).toMatch(/certificate/i);

    const working = path.join(work, 'tts-works.txt');
    fs.writeFileSync(working, 'The voice works again.');
    expect(await run(['play', working, '--player', process.execPath], '')).toBe(0);
    expect(JSON.parse(fs.readFileSync(statusFile, 'utf8')).ok).toBe(true);
  });
});
