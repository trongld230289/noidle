import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';

/**
 * Chạy hook thật (bundle như dist/claude-hook.js) với TEMP riêng để không đụng registry cửa sổ
 * và log của máy thật. Log của hook nằm ở <TEMP>/noidle-tts/hook.log.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-test-'));
const bundle = path.join(work, 'claude-hook.js');
const cfgMuted = path.join(work, 'muted.json');
const cfgNormal = path.join(work, 'normal.json');
const logFile = path.join(work, 'tmp', 'noidle-tts', 'hook.log');

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

describe('claude-hook background task notifications', () => {
  const notification = '<task-notification>\n<task-id>server</task-id>\n<status>failed</status>\n<summary>Background command failed with exit code 127</summary>\n</task-notification>';

  it('does not treat a task notification as a user prompt or change session language', async () => {
    const cfg = path.join(work, 'background-auto.json');
    fs.writeFileSync(cfg, JSON.stringify({ language: 'auto' }));
    const session = 'background-context';
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'Chạy ứng dụng giúp mình nhé' }));
    const before = readLog().length;
    const result = await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: notification }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(readLog().slice(before)).not.toContain('signal submitted');
    const mark = JSON.parse(fs.readFileSync(path.join(work, 'tmp', 'noidle-tts', 'sessions', session), 'utf8'));
    expect(mark.count).toBe(1);
    expect(mark.lang).toBe('vi');
  });

  it('silences a background-only turn, then speaks again after a real user prompt', async () => {
    const session = 'background-speech';
    const cfg = path.join(work, 'background-handsfree.json');
    fs.writeFileSync(cfg, JSON.stringify({ handsFree: true }));
    const transcript = path.join(work, 'background-transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: 'The backend and frontend are running again.' } }));
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: notification }));
    const before = readLog().length;
    const result = await run(['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
    expect(result.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).not.toContain('play pid');
    expect(added).not.toContain('signal listen');

    await run(['prompt', '--config', cfgNormal], JSON.stringify({ session_id: session, cwd: work, prompt: 'Please check the servers' }));
    const resumed = readLog().length;
    await run(['speak', '--config', cfgNormal, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
    expect(readLog().slice(resumed)).toContain('play pid');
  });

  it('reads the 🔊 section Claude wrote in a background turn, without opening the mic', async () => {
    const session = 'background-report';
    const cfg = path.join(work, 'background-report.json');
    fs.writeFileSync(cfg, JSON.stringify({ handsFree: true }));
    const transcript = path.join(work, 'background-report.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Review done.\n🔊 The task 4 review found one real bug.' }] } }) + '\n',
    );
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: notification }));
    const before = readLog().length;
    await run(['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
    const added = readLog().slice(before);
    expect(added).toContain('play pid');
    expect(added).toContain('task 4 review');
    expect(added).not.toContain('signal listen');
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

import { workspaceName } from '../src/speech';
import { pronounce } from '../src/pronounce';

describe('claude-hook workspace prefix', () => {
  const windowsDir = path.join(work, 'tmp', 'noidle-tts', 'windows');
  const transcript = path.join(work, 'transcript-ws.jsonl');
  const bogusPlayer = path.join(work, 'no-such-player.exe');

  function registerWindow(pid: number, folder: string): void {
    fs.mkdirSync(windowsDir, { recursive: true });
    fs.writeFileSync(path.join(windowsDir, `${pid}.json`), JSON.stringify({ pid, pipe: `pipe-${pid}`, folders: [folder] }));
  }
  async function spoken(cfgFile: string): Promise<string> {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '🔊 Xong việc.' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgFile, '--player', bogusPlayer], JSON.stringify({ session_id: 'ws-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    const m = /speak → play pid \d+ \([^)]*\): (".*")/.exec(readLog().slice(before));
    return m ? (JSON.parse(m[1]) as string) : '';
  }
  // Log ghi chữ đã qua bảng phiên âm ("Workspace" thành "guốc pây"), nên kỳ vọng cũng phải qua bảng đó.
  const prefixed = () => pronounce(`Workspace ${workspaceName(work)}: Xong việc.`);

  it('auto: nói tên workspace khi có hơn một cửa sổ VS Code, im khi chỉ có một', async () => {
    fs.rmSync(windowsDir, { recursive: true, force: true });
    registerWindow(11, work);
    expect(await spoken(cfgNormal)).toBe('Xong việc.');
    registerWindow(12, path.join(work, '..', 'other-project'));
    expect(await spoken(cfgNormal)).toBe(prefixed());
  });

  it('always và never ghi đè cách tự động', async () => {
    const always = path.join(work, 'say-always.json');
    const never = path.join(work, 'say-never.json');
    fs.writeFileSync(always, JSON.stringify({ voiceSayWorkspace: 'always' }));
    fs.writeFileSync(never, JSON.stringify({ voiceSayWorkspace: 'never' }));
    fs.rmSync(windowsDir, { recursive: true, force: true });
    registerWindow(11, work);
    expect(await spoken(always)).toBe(prefixed());
    registerWindow(12, path.join(work, '..', 'other-project'));
    expect(await spoken(never)).toBe('Xong việc.');
    fs.rmSync(windowsDir, { recursive: true, force: true });
  });
});

describe('claude-hook skip', () => {
  const queueDir = path.join(work, 'tmp', 'noidle-tts', 'queue');
  const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = (p: ReturnType<typeof spawn>) =>
    new Promise<boolean>((resolve) => {
      if (p.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), 3000);
      p.on('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });

  it('cắt tiếng đang phát: tắt player của vé đầu hàng, giữ tiến trình play để nó còn báo hands-free', async () => {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.mkdirSync(queueDir, { recursive: true });
    const play = idle();
    const player = idle();
    fs.writeFileSync(path.join(queueDir, `${String(Date.now()).padStart(15, '0')}-${play.pid}.json`), JSON.stringify({ pid: play.pid, player: player.pid, kind: 'speak', session: 's' }));
    const r = await run(['skip'], '');
    expect(r.code).toBe(0);
    expect(await exited(player)).toBe(true);
    expect(play.exitCode).toBeNull();
    play.kill();
  });

  it('vé đầu hàng chưa có player (đang tổng hợp) thì tắt luôn tiến trình play', async () => {
    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.mkdirSync(queueDir, { recursive: true });
    const play = idle();
    fs.writeFileSync(path.join(queueDir, `${String(Date.now()).padStart(15, '0')}-${play.pid}.json`), JSON.stringify({ pid: play.pid, kind: 'speak', session: 's' }));
    const r = await run(['skip'], '');
    expect(r.code).toBe(0);
    expect(await exited(play)).toBe(true);
  });
});

describe('claude-hook với Copilot Chat', () => {
  it('speak: nhận stdin và transcript của Copilot (assistant.message), đọc phần 🔊 của câu trả lời cuối', async () => {
    const transcript = path.join(work, 'transcript-copilot.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'session.start', data: { sessionId: 'c1', producer: 'copilot-agent' } }),
        JSON.stringify({ type: 'user.message', data: { content: 'hỏi' } }),
        JSON.stringify({ type: 'assistant.message', data: { content: 'Để tôi xem.', toolRequests: [{ name: 'read_file' }] } }),
        JSON.stringify({ type: 'assistant.message', data: { content: 'Xong.\n🔊 Copilot đã sửa xong rồi.' } }),
        JSON.stringify({ type: 'assistant.turn_end', data: { turnId: '1' } }),
      ].join('\n') + '\n',
    );
    const before = readLog().length;
    const r = await run(
      ['speak', '--config', cfgNormal, '--player', path.join(work, 'no-such-player.exe')],
      // Đúng các trường Copilot gửi: timestamp, hook_event_name, session_id, transcript_path, stop_hook_active, cwd.
      JSON.stringify({
        timestamp: '2026-09-21T16:50:23.719Z',
        hook_event_name: 'Stop',
        session_id: 'c1',
        transcript_path: transcript,
        stop_hook_active: false,
        cwd: work,
      }),
    );
    expect(r.code).toBe(0);
    // Bảng phát âm mặc định đổi Copilot thành "cô pai lợt".
    expect(readLog().slice(before)).toContain('cô pai lợt đã sửa xong rồi.');
  });
});

describe('claude-hook voiceStyle announce', () => {
  const cfgAnnounce = path.join(work, 'announce.json');
  const transcript = path.join(work, 'transcript-announce.jsonl');
  const bogusPlayer = path.join(work, 'no-such-player.exe');
  const playedText = (added: string) => {
    const m = /speak → play pid \d+ \([^)]*\): (".*")/.exec(added);
    return m ? (JSON.parse(m[1]) as string) : '';
  };
  beforeAll(() => fs.writeFileSync(cfgAnnounce, JSON.stringify({ voiceStyle: 'announce', voiceSayWorkspace: 'never' })));

  it('prompt: không chèn hướng dẫn 🔊, Claude không tốn token viết phần đọc', async () => {
    const r = await run(['prompt', '--config', cfgAnnounce], JSON.stringify({ session_id: 'an-1', cwd: work, prompt: 'sửa hàm A' }));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('speak: đọc câu cứng "Workspace X xong." thay vì nội dung câu trả lời', async () => {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Đã sửa xong hàm A, test pass.' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgAnnounce, '--player', bogusPlayer], JSON.stringify({ session_id: 'an-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    expect(playedText(readLog().slice(before))).toBe(pronounce(`Workspace ${workspaceName(work)} xong.`));
  });

  it('speak: câu trả lời kết thúc bằng dấu hỏi thì đọc "đang hỏi bạn"', async () => {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Có hai cách.\n\nBạn muốn cách nào?' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgAnnounce, '--player', bogusPlayer], JSON.stringify({ session_id: 'an-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    expect(playedText(readLog().slice(before))).toBe(pronounce(`Workspace ${workspaceName(work)} đang hỏi bạn.`));
  });
});
