import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { readInbox, writeDecision } from '../src/inbox';
import { writeLock } from '../src/lock';

/** Chạy bundle thật (như dist/hub.js) với TEMP, HOME cấu hình và settings Claude riêng; không tách server nền. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-'));
const bundle = path.join(work, 'hub.js');
const tmp = path.join(work, 'tmp');
const home = path.join(work, 'home');
const claudeHome = path.join(work, 'claude');
const root = path.join(tmp, 'vi-voice-hub');
const inbox = path.join(root, 'inbox');

function run(args: string[], stdin = '', env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, VI_VOICE_HUB_HOME: home, VI_VOICE_HUB_CLAUDE_HOME: claudeHome, VI_VOICE_HUB_NO_SERVE: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}
const hook = (event: string, input: object) => run(['hook', event], JSON.stringify(input));
const entry = (session: string) => readInbox(inbox).find((e) => e.session === session);

beforeAll(async () => {
  fs.mkdirSync(tmp, { recursive: true });
  await build({ entryPoints: [path.join(__dirname, '..', 'src', 'main.ts')], bundle: true, outfile: bundle, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent' });
}, 30_000);

describe('install / uninstall', () => {
  it('writes config enabled, adds hooks to the Claude settings and prints URLs; uninstall removes them', async () => {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js speak' }] }] } }));
    const r = await run(['install', '--lan', '--port', '4555', '--lang', 'en']);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.vi-voice', 'hub.json'), 'utf8'));
    expect(cfg).toMatchObject({ enabled: true, lan: true, port: 4555, lang: 'en' });
    expect(r.stdout).toContain(`http://127.0.0.1:4555/t/${cfg.token}/`);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[1].hooks[0].command).toContain('--vi-voice-hub');
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(120);
    expect(fs.existsSync(path.join(claudeHome, 'settings.json.bak'))).toBe(true);

    const u = await run(['uninstall']);
    expect(u.code).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.PermissionRequest).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, '.vi-voice', 'hub.json'), 'utf8')).enabled).toBe(false);
  });
});

describe('hook', () => {
  it('does nothing while disabled, then records events once enabled', async () => {
    await hook('UserPromptSubmit', { session_id: 'off', cwd: work, prompt: 'x' });
    expect(fs.existsSync(inbox)).toBe(false);
    await run(['install']);
    const r = await hook('UserPromptSubmit', { session_id: 's1', cwd: path.join(work, 'shop'), prompt: 'sửa lỗi login' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(entry('s1')).toMatchObject({ state: 'working', workspace: 'shop', lastPrompt: 'sửa lỗi login' });
  });
  it('Stop records the spoken part and blocks with a queued command', async () => {
    const transcript = path.join(work, 't.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: '🔊 Xong việc.' } }) + '\n');
    let r = await hook('Stop', { session_id: 's1', cwd: path.join(work, 'shop'), transcript_path: transcript });
    expect(r.stdout).toBe('');
    expect(entry('s1')).toMatchObject({ state: 'done', lastSpoken: 'Xong việc.' });
    fs.writeFileSync(path.join(inbox, 's1.queue'), JSON.stringify({ text: 'giờ chạy test' }));
    r = await hook('Stop', { session_id: 's1', cwd: path.join(work, 'shop'), transcript_path: transcript });
    expect(JSON.parse(r.stdout)).toEqual({ decision: 'block', reason: 'giờ chạy test' });
    expect(entry('s1')!.state).toBe('working');
  });
  it('PermissionRequest returns at once when nobody is watching, and honours a web decision when someone is', async () => {
    const r = await hook('PermissionRequest', { session_id: 's1', cwd: work, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(1500);
    expect(entry('s1')).toMatchObject({ state: 'waiting_approve', pending: { toolName: 'Bash', summary: 'npm test', dangerous: false } });

    // Có người xem (khoá với lastClientAt mới, pid là chính test) và quyết định đã ghi sẵn.
    writeLock(root, { pid: process.pid, port: 1, at: Date.now(), lastClientAt: Date.now() });
    writeDecision(inbox, 's1', { decision: 'allow' });
    const ok = await hook('PermissionRequest', { session_id: 's1', cwd: work, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(JSON.parse(ok.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(entry('s1')!.state).toBe('working');
  });
  it('waits for a decision written while the hook is pending', async () => {
    writeLock(root, { pid: process.pid, port: 1, at: Date.now(), lastClientAt: Date.now() });
    const p = hook('PreToolUse', { session_id: 's1', cwd: work, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } });
    await new Promise((r) => setTimeout(r, 900));
    expect(entry('s1')!.state).toBe('waiting_answer');
    writeDecision(inbox, 's1', { answer: [1] });
    const r = await p;
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('"B"');
  });
  it('status prints sessions and URLs', async () => {
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/working|waiting_answer/);
    expect(r.stdout).toContain('/t/');
  });
});
