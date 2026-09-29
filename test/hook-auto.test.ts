import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';

/**
 * Hook thật với config language: "auto": ngôn ngữ lấy từ prompt vừa gửi, nhớ theo phiên,
 * prompt ngắn không đoán được thì giữ ngôn ngữ cũ, đổi ngôn ngữ thì chèn lại hướng dẫn đầy đủ.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-auto-test-'));
const bundle = path.join(work, 'claude-hook.js');
const cfgAuto = path.join(work, 'auto.json');
const logFile = path.join(work, 'tmp', 'noidle-tts', 'hook.log');
const noPlayer = path.join(work, 'no-such-player.exe');

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
const ctx = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
const prompt = (session: string, text: string) => run(['prompt', '--config', cfgAuto], JSON.stringify({ session_id: session, cwd: work, prompt: text }));

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
  fs.writeFileSync(cfgAuto, JSON.stringify({ language: 'auto' }));
}, 30_000);

describe('hook with language auto', () => {
  it.each(['speak', 'notify'])('%s uses the updated voice config even with stale hook arguments', async (mode) => {
    const configFile = path.join(work, `voice-${mode}.json`);
    const transcript = path.join(work, `voice-${mode}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: '🔊 Voice configuration check.' } }) + '\n');
    const args = [mode, '--config', configFile, '--voice', 'en-US-BrianMultilingualNeural', '--player', noPlayer];
    const input = JSON.stringify({ session_id: `voice-${mode}`, cwd: work, transcript_path: transcript, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    for (const voice of ['en-US-EmmaMultilingualNeural', 'en-US-AndrewMultilingualNeural']) {
      fs.writeFileSync(configFile, JSON.stringify({ language: 'en', voice }));
      const before = readLog().length;
      const result = await run(args, input);
      expect(result.code).toBe(0);
      expect(readLog().slice(before)).toContain(`(${voice})`);
    }
  });

  it('follows the language of each prompt and remembers it for short prompts', async () => {
    const first = ctx((await prompt('auto-a', 'please refactor the claimNext function')).stdout);
    expect(first).toMatch(/English/);
    expect(first).not.toMatch(/tiếng Việt/);

    const second = ctx((await prompt('auto-a', 'ok')).stdout);
    expect(second).toBe(first); // "ok" không đoán được: giữ tiếng Anh, hướng dẫn gửi nguyên mỗi lượt

    const third = ctx((await prompt('auto-a', 'giờ sửa lỗi này giúp mình')).stdout);
    expect(third).toMatch(/tiếng Việt/); // đổi ngôn ngữ: hướng dẫn tiếng Việt
    expect(third).not.toMatch(/English/);

    const fourth = ctx((await prompt('auto-a', 'ừ')).stdout);
    expect(fourth).toBe(third);
  });

  it('ignores prompts sent by subagents: no context, no language switch, no submitted signal', async () => {
    await prompt('auto-sub', 'sửa lỗi này giúp mình');
    const r = await run(
      ['prompt', '--config', cfgAuto],
      JSON.stringify({ session_id: 'auto-sub', cwd: work, prompt: 'Find the exact JSON format in the docs', agent_id: 'a1', agent_type: 'claude-code-guide' }),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const next = ctx((await prompt('auto-sub', 'ok')).stdout);
    expect(next).toMatch(/tiếng Việt/);
    expect(readLog()).toContain('của subagent claude-code-guide, bỏ qua');
  });

  it('defaults to Vietnamese when nothing is known about the session', async () => {
    const r = ctx((await prompt('auto-b', 'ok')).stdout);
    expect(r).toMatch(/tiếng Việt/);
  });

  it('notify and speak use the language remembered for the session', async () => {
    await prompt('auto-c', 'run the tests and fix whatever breaks');
    let before = readLog().length;
    let r = await run(
      ['notify', '--config', cfgAuto, '--player', noPlayer],
      JSON.stringify({ session_id: 'auto-c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: path.join(work, 'shop') }),
    );
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toContain('Workspace shop needs approval.');

    // Cùng phiên, tiếng Anh: bỏ bảng phiên âm tiếng Việt và giọng vi-VN đổi sang giọng đa ngôn ngữ.
    const transcript = path.join(work, 'transcript-auto.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: '🔊 Done, README.md is updated.' } }) + '\n');
    before = readLog().length;
    r = await run(
      ['speak', '--config', cfgAuto, '--voice', 'vi-VN-HoaiMyNeural', '--player', noPlayer],
      JSON.stringify({ session_id: 'auto-c', cwd: work, transcript_path: transcript }),
    );
    expect(r.code).toBe(0);
    const added = readLog().slice(before);
    expect(added).toContain('Done, README.md is updated.');
    expect(added).toContain('en-US-AvaMultilingualNeural');

    // Phiên khác chưa biết gì: tiếng Việt.
    before = readLog().length;
    r = await run(
      ['notify', '--config', cfgAuto, '--player', noPlayer],
      JSON.stringify({ session_id: 'auto-d', hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: path.join(work, 'shop') }),
    );
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toContain('Workspace shop cần approve.');
  });
});
