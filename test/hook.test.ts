import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { startServer, writeRegistry, removeRegistry, pipeName, type Signal } from '../src/signal';

/**
 * Chạy hook thật (bundle như dist/claude-hook.js) với TEMP riêng để không đụng registry cửa sổ
 * và log của máy thật. Log của hook nằm ở <TEMP>/noidle-tts/hook.log.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-test-'));
const bundle = path.join(work, 'claude-hook.js');
const cfgMuted = path.join(work, 'muted.json');
const cfgNormal = path.join(work, 'normal.json');
// Tắt giọng và tắt Hands Free: hook chỉ báo cửa sổ, không đọc, không chờ mic (Hands Free bật thì hook đi nghe duyệt lệnh).
const cfgSilent = path.join(work, 'silent.json');
const logFile = path.join(work, 'tmp', 'noidle-tts', 'hook.log');

function run(args: string[], stdin: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    // Không bao giờ phát ra loa thật trong test: speak/notify thiếu --player thì dùng player giả (2026-09-29 test đỏ từng đọc to).
    if (['speak', 'notify'].includes(args[0]) && !args.includes('--player')) args = [...args, '--player', path.join(work, 'no-such-player.exe')];
    const tmp = path.join(work, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...extraEnv },
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
/**
 * Chờ tiến trình play tách rời ghi dòng này vào log (tối đa ms). Test nào để hook tách play với --listen phải chờ
 * dòng "signal listen" của nó, không thì dòng đó rớt sang cửa sổ log của test sau (test sau "không mở mic" đỏ giả).
 */
async function waitLog(from: number, text: string, ms = 15_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = readLog().slice(from);
    if (s.includes(text)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readLog().slice(from);
}

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
  // Lần chạy đầu của bundle mới trên Windows chậm vài giây (Defender quét file): làm nóng ở đây để test đầu không timeout.
  await run(['skip'], '');
  fs.writeFileSync(cfgMuted, JSON.stringify({ voiceResponse: false, handsFree: true }));
  fs.writeFileSync(cfgNormal, JSON.stringify({ voiceResponse: true, handsFree: false }));
  fs.writeFileSync(cfgSilent, JSON.stringify({ voiceResponse: false, handsFree: false }));
}, 30_000);

describe('claude-hook voiceResponse off (im lặng, vẫn nháy)', () => {
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

  it('speak: mute thì không phát tiếng nhưng vẫn gửi listen khi Hands Free bật', async () => {
    const transcript = path.join(work, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong.\n🔊 Đã xong việc.' }] } }) + '\n',
    );
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgMuted], JSON.stringify({ session_id: 's2', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('voiceResponse tắt');
    expect(added).not.toContain('play pid');
    expect(added).toContain('signal listen');
  });

  it('notify: mute thì im lặng, không tách tiến trình play', async () => {
    const before = readLog().length;
    const r = await run(
      ['notify', '--config', cfgSilent],
      JSON.stringify({ session_id: 's3', cwd: work, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('voiceResponse tắt');
    expect(added).not.toContain('play pid');
  });

  it('notify: voiceNotify tắt thì không đọc câu báo, nhưng vẫn báo cửa sổ', async () => {
    const cfg = path.join(work, 'notify-off.json');
    fs.writeFileSync(cfg, JSON.stringify({ voiceResponse: true, voiceNotify: false }));
    const before = readLog().length;
    const r = await run(
      ['notify', '--config', cfg],
      JSON.stringify({ session_id: 's3b', cwd: work, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('voiceNotify tắt');
    expect(added).toContain('signal attention');
    expect(added).not.toContain('play pid');
  });

  it('attentionFlash tắt thì không nháy cửa sổ chứa agent, chỉ báo extension (đổi màu)', async () => {
    const cfg = path.join(work, 'flash-off.json');
    fs.writeFileSync(cfg, JSON.stringify({ voiceResponse: false, attentionFlash: false }));
    const before = readLog().length;
    const r = await run(
      ['notify', '--config', cfg],
      JSON.stringify({ session_id: 's3c', cwd: work, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('attentionFlash tắt');
    expect(added).toContain('signal attention');
  });
});

describe('claude-hook background task notifications', () => {
  const notification = '<task-notification>\n<task-id>server</task-id>\n<status>failed</status>\n<summary>Background command failed with exit code 127</summary>\n</task-notification>';

  it('does not treat a task notification as a user prompt or change session language, but signals resumed so the window drops its "done" state', async () => {
    const cfg = path.join(work, 'background-auto.json');
    fs.writeFileSync(cfg, JSON.stringify({ language: 'auto' }));
    const session = 'background-context';
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'Chạy ứng dụng giúp mình nhé' }));
    const before = readLog().length;
    const result = await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: notification }));
    expect(result.code).toBe(0);
    // 7/10/2026: thiếu hướng dẫn thì Claude viết phần 🔊 bằng tiếng Anh theo tin nhắn hệ thống: vẫn dặn, theo ngôn ngữ phiên.
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('tiếng Việt');
    expect(readLog().slice(before)).not.toContain('signal submitted');
    expect(readLog().slice(before)).toContain('resumed');
    const mark = JSON.parse(fs.readFileSync(path.join(work, 'tmp', 'noidle-tts', 'sessions', session), 'utf8'));
    expect(mark.count).toBe(1);
    expect(mark.lang).toBe('vi');
    expect(mark.resumed).toBe(true);
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'ok tiếp đi' }));
    expect(JSON.parse(fs.readFileSync(path.join(work, 'tmp', 'noidle-tts', 'sessions', session), 'utf8')).resumed).toBeUndefined();
  });

  it('the answer to a system message queues behind the one still being read instead of cutting it', async () => {
    // 7/10/2026: câu tiếng Việt đang đọc bị câu trả lời cho thông báo việc nền cắt ngang, nghe hai câu dính nhau.
    const session = 'resumed-queue';
    const cfg = path.join(work, 'resumed-queue.json');
    fs.writeFileSync(cfg, JSON.stringify({ language: 'auto' }));
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'Push và tạo PR đi' }));
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: notification }));
    const reading = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    const queue = path.join(work, 'tmp', 'noidle-tts', 'queue');
    fs.mkdirSync(queue, { recursive: true });
    const ticket = path.join(queue, `${String(Date.now() - 1000).padStart(15, '0')}-${reading.pid}.json`);
    fs.writeFileSync(ticket, JSON.stringify({ pid: reading.pid, kind: 'speak', session }));
    try {
      const transcript = path.join(work, 'resumed-queue.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong.\n\n🔊 Thông báo đó cũ, không có gì đổi.' }] } }));
      await run(['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
      // Tiến trình play tách rời lấy vé sau khi speak thoát: chờ vé của nó xuất hiện.
      const t0 = Date.now();
      while (fs.readdirSync(queue).filter((f) => f !== path.basename(ticket) && fs.readFileSync(path.join(queue, f), 'utf8').includes(session)).length === 0 && Date.now() - t0 < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(reading.exitCode).toBeNull();
      expect(fs.existsSync(ticket)).toBe(true);
    } finally {
      reading.kill();
      fs.rmSync(ticket, { force: true });
    }
  });

  it('a subagent hand-back message is system text too: instruction stays in the session language, no language switch, only resumed', async () => {
    // 3/10/2026: "<agent-message ...>[Subagent hand-back] ..." bị coi là prompt tiếng Anh → Claude đọc phần 🔊 bằng tiếng Anh
    // ngay sau một đoạn tiếng Việt.
    const cfg = path.join(work, 'background-auto.json');
    fs.writeFileSync(cfg, JSON.stringify({ language: 'auto' }));
    const session = 'agent-message-context';
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'Review giúp mình bước 13' }));
    const before = readLog().length;
    const message = '<agent-message from="af0e2c4c91ed3a19f">\n[Subagent hand-back] The text below is the final report of a subagent.\n  ## Review: done\n</agent-message>';
    const result = await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: message }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('tiếng Việt');
    expect(readLog().slice(before)).toContain('resumed');
    const mark = JSON.parse(fs.readFileSync(path.join(work, 'tmp', 'noidle-tts', 'sessions', session), 'utf8'));
    expect(mark.count).toBe(1);
    expect(mark.lang).toBe('vi');
  });

  it('a turn that ends with a prompt still queued (typed while Claude worked) is silent: Claude starts on it right away', async () => {
    const session = 'queued-speech';
    const cfg = path.join(work, 'queued-handsfree.json');
    fs.writeFileSync(cfg, JSON.stringify({ handsFree: true }));
    const transcript = path.join(work, 'queued-transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: session, content: 'đang làm nó xanh lên kìa' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done with this part.' }] } }),
    ].join('\n'));
    const before = readLog().length;
    const result = await run(['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
    expect(result.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('xếp hàng');
    expect(added).not.toContain('play pid');
    expect(added).not.toContain('attention');
    expect(added).not.toContain('signal listen');
  });

  const agentLaunch = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Async agent launched successfully.' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'server' } });
  const notificationRow = JSON.stringify({ type: 'user', message: { content: notification } });

  it('a turn that leaves a background agent running is silent even with a 🔊 section: no speech, no "done", no attention, no mic; the turn after its notification, with nothing left running, announces and opens the mic', async () => {
    // 12/10/2026: prompt bắt Claude viết 🔊 ở mọi câu trả lời, nên lượt chờ việc nền nào cũng có 🔊; đọc hết thì
    // cứ vài chục giây lại "test được 44%, vẫn đang chờ". Mục tiêu là báo lúc xong hay cần approve, không phải tường thuật.
    const session = 'background-speech';
    const cfg = path.join(work, 'background-handsfree.json');
    fs.writeFileSync(cfg, JSON.stringify({ handsFree: true }));
    const transcript = path.join(work, 'background-transcript.jsonl');
    fs.writeFileSync(transcript, [agentLaunch, JSON.stringify({ type: 'assistant', message: { content: 'Task 1 is running; waiting for its report.\n\n🔊 Test được 44%, mình vẫn đang chờ.' } })].join('\n'));
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'Run the plan with subagents' }));
    const before = readLog().length;
    const result = await run(['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
    expect(result.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('việc nền');
    expect(added).not.toContain('play pid');
    expect(added).not.toContain('attention');
    expect(added).not.toContain('signal listen');

    fs.appendFileSync(transcript, '\n' + [notificationRow, JSON.stringify({ type: 'assistant', message: { content: 'The backend and frontend are running again.' } })].join('\n'));
    await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: notification }));
    const resumed = readLog().length;
    await run(['speak', '--config', cfg, '--player', path.join(work, 'no-such-player.exe')], JSON.stringify({ session_id: session, cwd: work, transcript_path: transcript }));
    const after = readLog().slice(resumed);
    expect(after).toContain('play pid');
    expect(after).toContain('signal attention');
    // Mở mic: tiến trình play tách rời gửi listen sau khi phát (player giả lỗi ngay). Chờ nó ở đây cho đủ lời hứa của test.
    expect(await waitLog(resumed, 'signal listen')).toContain('signal listen');
  }, 30_000);

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
    // --voice vi-VN: bảng phiên âm mặc định chỉ bật cho giọng vi-VN (mặc định cài là Brian đa ngôn ngữ, tắt bảng).
    const r = await run(
      ['speak', '--config', cfg, '--voice', 'vi-VN-HoaiMyNeural', '--player', path.join(work, 'no-such-player.exe')],
      JSON.stringify({ session_id: 's4', cwd: work, transcript_path: transcript }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('cờ lốt đã đọc README chấm em đi và gọi ây pi ai.');
  });
});

/**
 * Extension gọi `claude -p` để dịch recapPrompt; tiến trình đó kế thừa hook của người dùng nên từng bắn "submitted"
 * (tắt mic) và Stop → "Workspace X is done" giả (2026-09-29). Extension đặt NOIDLE_INTERNAL=1, hook thấy là thoát ngay.
 */
describe('claude-hook NOIDLE_INTERNAL', () => {
  const env = { NOIDLE_INTERNAL: '1' };
  it('prompt: không chèn hướng dẫn, không gửi submitted', async () => {
    const before = readLog().length;
    const r = await run(['prompt', '--config', cfgNormal], JSON.stringify({ session_id: 'internal-1', cwd: work, prompt: 'Translate this' }), env);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
    const added = readLog().slice(before);
    expect(added).not.toContain('signal submitted');
    expect(added).toContain('NOIDLE_INTERNAL');
  });

  it('speak: không đọc "done", không nháy cửa sổ', async () => {
    const transcript = path.join(work, 'transcript-internal.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Keep it short.' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(
      ['speak', '--config', cfgNormal, '--player', path.join(work, 'no-such-player.exe')],
      JSON.stringify({ session_id: 'internal-1', cwd: work, transcript_path: transcript }),
      env,
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).not.toContain('speak → play');
    expect(added).not.toContain('attention');
  });
});

describe('claude-hook prompt context per session', () => {
  const prompt = (session: string) => run(['prompt', '--config', cfgNormal], JSON.stringify({ session_id: session, cwd: work }));
  const ctx = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

  // Hướng dẫn giờ là prompt ngắn người dùng tự sửa, gửi nguyên mỗi lượt: không còn bản đầy đủ / nhắc ngắn.
  it('mỗi prompt của phiên đều chèn cùng một hướng dẫn: hợp đồng 🔊, thân mặc định, câu ngôn ngữ', async () => {
    const first = ctx((await prompt('ctx-a')).stdout);
    expect(first).toContain('🔊');
    expect(first).toContain(DEFAULT_RECAP_PROMPT.vi);
    expect(first).toMatch(/tiếng Việt\.$/);
    expect(ctx((await prompt('ctx-a')).stdout)).toBe(first);
    expect(ctx((await prompt('ctx-a')).stdout)).toBe(first);
  });

  it('không có session_id thì vẫn chèn như thường', async () => {
    const r = await run(['prompt', '--config', cfgNormal], JSON.stringify({ cwd: work }));
    expect(ctx(r.stdout)).toContain(DEFAULT_RECAP_PROMPT.vi);
  });

  it('recapPrompt trong hook-config thay phần thân, hợp đồng 🔊 vẫn được nối', async () => {
    const cfg = path.join(work, 'recap-custom.json');
    fs.writeFileSync(cfg, JSON.stringify({ recapPrompt: { vi: 'Ngắn thôi, hai câu.', en: 'Keep it short, two sentences.' } }));
    const text = ctx((await run(['prompt', '--config', cfg], JSON.stringify({ session_id: 'ctx-custom', cwd: work }))).stdout);
    expect(text).toContain('Ngắn thôi, hai câu.');
    expect(text).not.toContain('Keep it short');
    expect(text).not.toContain(DEFAULT_RECAP_PROMPT.vi);
    expect(text).toContain('🔊');
    expect(text).toMatch(/tiếng Việt\.$/);
  });

  it('language en: lấy bản tiếng Anh; chưa dịch thì dùng bản gốc cộng câu "Write that section in English"', async () => {
    const both = path.join(work, 'recap-en.json');
    fs.writeFileSync(both, JSON.stringify({ language: 'en', recapPrompt: { vi: 'Ngắn thôi.', en: 'Keep it short.' } }));
    const translated = ctx((await run(['prompt', '--config', both], JSON.stringify({ session_id: 'ctx-en', cwd: work }))).stdout);
    expect(translated).toContain('Keep it short.');
    expect(translated).not.toContain('Ngắn thôi.');
    expect(translated).toMatch(/Write that section in English\.$/);

    const pending = path.join(work, 'recap-en-pending.json');
    fs.writeFileSync(pending, JSON.stringify({ language: 'en', recapPrompt: { vi: 'Ngắn thôi.' } }));
    const fallback = ctx((await run(['prompt', '--config', pending], JSON.stringify({ session_id: 'ctx-en2', cwd: work }))).stdout);
    expect(fallback).toContain('Ngắn thôi.');
    expect(fallback).toMatch(/Write that section in English\.$/);
  });
});

import { workspaceName } from '../src/speech';
import { pronounce } from '../src/pronounce';
import { DEFAULT_RECAP_PROMPT } from '../src/recapPrompt';

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
    const r = await run(['speak', '--config', cfgFile, '--voice', 'vi-VN-HoaiMyNeural', '--player', bogusPlayer], JSON.stringify({ session_id: 'ws-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    const m = /speak → play pid \d+ \([^)]*\): (".*")/.exec(readLog().slice(before));
    return m ? (JSON.parse(m[1]) as string) : '';
  }
  // Log ghi chữ đã qua bảng phiên âm ("Workspace" thành "guốc pây"), nên kỳ vọng cũng phải qua bảng đó.
  const prefixed = () => pronounce(`Workspace ${workspaceName(work)}: Xong việc.`);

  it('auto: nói tên workspace khi có hơn một cửa sổ VS Code, im khi chỉ có một', async () => {
    fs.rmSync(windowsDir, { recursive: true, force: true });
    // pid phải còn sống: hook dọn đăng ký của cửa sổ chết trước khi đếm.
    registerWindow(process.pid, work);
    expect(await spoken(cfgNormal)).toBe('Xong việc.');
    registerWindow(process.ppid, path.join(work, '..', 'other-project'));
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
  // Vé đặt tên bằng mốc 0 để luôn đứng đầu hàng: tiến trình play nền của các test speak trước có thể ghi vé vào cùng lúc.
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
    fs.writeFileSync(path.join(queueDir, `${'0'.padStart(15, '0')}-${play.pid}.json`), JSON.stringify({ pid: play.pid, player: player.pid, kind: 'speak', session: 's' }));
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
    fs.writeFileSync(path.join(queueDir, `${'0'.padStart(15, '0')}-${play.pid}.json`), JSON.stringify({ pid: play.pid, kind: 'speak', session: 's' }));
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
      ['speak', '--config', cfgNormal, '--voice', 'vi-VN-HoaiMyNeural', '--player', path.join(work, 'no-such-player.exe')],
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

  it('speak: đọc câu cứng tiếng Anh "Workspace X is done." thay vì nội dung câu trả lời', async () => {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Đã sửa xong hàm A, test pass.' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgAnnounce, '--player', bogusPlayer], JSON.stringify({ session_id: 'an-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    expect(playedText(readLog().slice(before))).toBe(`Workspace ${workspaceName(work, 'en')} is done.`);
  });

  it('speak: câu trả lời kết thúc bằng dấu hỏi thì đọc "is asking you"', async () => {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Có hai cách.\n\nBạn muốn cách nào?' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgAnnounce, '--player', bogusPlayer], JSON.stringify({ session_id: 'an-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    expect(playedText(readLog().slice(before))).toBe(`Workspace ${workspaceName(work, 'en')} is asking you.`);
  });
});

describe('claude-hook đổi voiceStyle giữa phiên', () => {
  const cfgRecap = path.join(work, 'style-recap.json');
  const cfgAnnounce = path.join(work, 'style-announce.json');
  beforeAll(() => {
    fs.writeFileSync(cfgRecap, JSON.stringify({ voiceStyle: 'recap' }));
    fs.writeFileSync(cfgAnnounce, JSON.stringify({ voiceStyle: 'announce' }));
  });
  const ctx = async (cfg: string, session: string) => {
    const r = await run(['prompt', '--config', cfg], JSON.stringify({ session_id: session, cwd: work, prompt: 'làm tiếp' }));
    expect(r.code).toBe(0);
    if (!r.stdout.trim()) return '';
    return (JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
  };

  it('recap → announce: chèn một dòng bảo Claude thôi viết phần 🔊, lần sau không chèn gì', async () => {
    expect(await ctx(cfgRecap, 'sw-1')).toContain(DEFAULT_RECAP_PROMPT.vi);
    const note = await ctx(cfgAnnounce, 'sw-1');
    expect(note).toContain('🔊');
    expect(note).toMatch(/không cần/);
    expect(note.length).toBeLessThan(200);
    expect(await ctx(cfgAnnounce, 'sw-1')).toBe('');
  });

  it('announce → recap: chèn lại hướng dẫn recap', async () => {
    expect(await ctx(cfgAnnounce, 'sw-2')).toBe('');
    expect(await ctx(cfgAnnounce, 'sw-2')).toBe('');
    expect(await ctx(cfgRecap, 'sw-2')).toContain(DEFAULT_RECAP_PROMPT.vi);
  });

  // Claude tự viết phần 🔊 dù hook không dặn (thói quen từ memory hay lượt trước): announce thì nhắc thôi, mỗi khi còn thấy.
  it('announce: câu trả lời trước có phần 🔊 thì nhắc thôi viết, không có thì im', async () => {
    const transcript = path.join(work, 'transcript-habit.jsonl');
    const row = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
    const ctxT = async (session: string) => {
      const r = await run(['prompt', '--config', cfgAnnounce], JSON.stringify({ session_id: session, cwd: work, prompt: 'làm tiếp', transcript_path: transcript }));
      expect(r.code).toBe(0);
      if (!r.stdout.trim()) return '';
      return (JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
    };
    fs.writeFileSync(transcript, row('Xong rồi.'));
    expect(await ctxT('habit-1')).toBe('');
    fs.writeFileSync(transcript, row('Đã sửa.\n\n🔊 Sửa xong hai điểm.'));
    const note = await ctxT('habit-1');
    expect(note).toMatch(/không cần/);
    expect(note).toContain('🔊');
    expect(await ctxT('habit-1')).toMatch(/không cần/);
    fs.writeFileSync(transcript, row('Rõ, không viết nữa.'));
    expect(await ctxT('habit-1')).toBe('');
  });
});

describe('claude-hook tín hiệu attention', () => {
  const cfg = path.join(work, 'attention.json');
  const transcript = path.join(work, 'transcript-att.jsonl');
  const bogusPlayer = path.join(work, 'no-such-player.exe');
  beforeAll(() => fs.writeFileSync(cfg, JSON.stringify({ voiceStyle: 'announce' })));

  it('speak: Claude xong thì gửi attention (lý do done) cho cửa sổ của cwd', async () => {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong.' }] } }) + '\n');
    const before = readLog().length;
    const r = await run(['speak', '--config', cfg, '--player', bogusPlayer], JSON.stringify({ session_id: 'att-1', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toMatch(/signal attention/);
  });

  it('notify: cần approve thì gửi attention (lý do approve), kể cả khi mute', async () => {
    const before = readLog().length;
    const r = await run(
      ['notify', '--config', cfgSilent, '--player', bogusPlayer],
      JSON.stringify({ session_id: 'att-2', cwd: work, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }),
    );
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toMatch(/signal attention/);
  });
});

describe('claude-hook attention với Copilot Chat', () => {
  it('Copilot trả lời xong (Stop, --source copilot) cũng gửi attention cho cửa sổ của workspace', async () => {
    const transcript = path.join(work, 'transcript-copilot-att.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant.message', data: { content: 'Xong rồi.' } }) + '\n');
    const before = readLog().length;
    const r = await run(
      ['speak', '--config', cfgSilent, '--source', 'copilot'],
      JSON.stringify({ session_id: 'cp-att', cwd: work, transcript_path: transcript, stop_hook_active: false }),
    );
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toMatch(/signal attention/);
  });
});

describe('claude-hook default voice', () => {
  it('speak without --voice uses Brian and skips the Vietnamese transliteration table', async () => {
    const transcript = path.join(work, 'transcript-default-voice.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '🔊 Claude đã đọc README.md và gọi API.' }] } }) + '\n',
    );
    const before = readLog().length;
    const r = await run(
      ['speak', '--config', cfgNormal, '--player', path.join(work, 'no-such-player.exe')],
      JSON.stringify({ session_id: 's5', cwd: work, transcript_path: transcript }),
    );
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toContain('(en-US-BrianMultilingualNeural): "Claude đã đọc README.md và gọi API."');
  });
});

describe('claude-hook attention chọn cửa sổ theo chuỗi pid của agent', () => {
  const regDir = path.join(work, 'tmp', 'noidle-tts', 'windows');
  it('Copilot Chat: cửa sổ có pid trong chuỗi tổ tiên của hook nhận attention, dù cwd không thuộc folder của nó', async () => {
    // Hook là con của tiến trình test, như hook Copilot Chat là con của extension host: pid test nằm trong chuỗi.
    const got: Signal[] = [];
    const pipe = pipeName(process.pid * 1000 + 7);
    const server = startServer(pipe, (s) => {
      if (s.event === 'probe') return s.ancestors?.includes(process.pid) ? 'owned' : 'no';
      got.push(s);
      return undefined;
    });
    await new Promise((r) => server.once('listening', r));
    writeRegistry({ pid: process.pid, pipe, folders: [path.join(work, 'elsewhere')] }, regDir);
    const transcript = path.join(work, 'transcript-copilot-owner.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant.message', data: { content: 'Xong rồi.' } }) + '\n');
    const before = readLog().length;
    try {
      const r = await run(['speak', '--config', cfgSilent, '--source', 'copilot'], JSON.stringify({ session_id: 'cp-owner', cwd: work, transcript_path: transcript }));
      expect(r.code).toBe(0);
      const att = got.filter((s) => s.event === 'attention');
      expect(att.length).toBe(1);
      expect(att[0].ancestors).toContain(process.pid);
      expect(readLog().slice(before)).toMatch(/signal attention → cửa sổ pid \d+ \(đang chứa agent\)/);
    } finally {
      removeRegistry(process.pid, regDir);
      server.close();
    }
  });
});
