import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleHook } from '../src/hook';
import { readInbox, writeQueue, takeFlag, setFlag } from '../src/inbox';
import type { HubConfig } from '../src/config';

const cfg: HubConfig = { enabled: true, port: 4319, lan: false, token: 'a'.repeat(32), waitSec: 90, lang: 'vi' };
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hook-'));
const entry = (dir: string, session: string) => readInbox(dir, Date.now()).find((e) => e.session === session);

describe('UserPromptSubmit', () => {
  it('marks the session working with the prompt and clears pending; ignores subagents', async () => {
    const dir = fresh();
    await handleHook('PermissionRequest', { session_id: 's', cwd: 'D:/p/shop', tool_name: 'Bash', tool_input: { command: 'ls' } }, { dir, cfg });
    expect(entry(dir, 's')?.state).toBe('waiting_approve');
    const out = await handleHook('UserPromptSubmit', { session_id: 's', cwd: 'D:/p/shop', prompt: '  sửa   lỗi\nnày ' + 'x'.repeat(300) }, { dir, cfg });
    expect(out).toBeUndefined();
    const e = entry(dir, 's')!;
    expect(e).toMatchObject({ state: 'working', workspace: 'shop', cwd: 'D:/p/shop' });
    expect(e.lastPrompt).toHaveLength(200);
    expect(e.lastPrompt!.startsWith('sửa lỗi này')).toBe(true);
    expect(e.pending).toBeUndefined();
    await handleHook('UserPromptSubmit', { session_id: 's2', cwd: 'D:/p', prompt: 'find docs', agent_id: 'a1' }, { dir, cfg });
    expect(entry(dir, 's2')).toBeUndefined();
  });
});

describe('Stop', () => {
  const transcript = JSON.stringify({ type: 'assistant', message: { content: 'Đã sửa.\n\n🔊 Xong rồi, **hai** file.' } });
  it('records done with the spoken part', async () => {
    const dir = fresh();
    const out = await handleHook('Stop', { session_id: 's', cwd: 'D:/p', transcript_path: 't' }, { dir, cfg, readFile: () => transcript });
    expect(out).toBeUndefined();
    expect(entry(dir, 's')).toMatchObject({ state: 'done', lastSpoken: 'Xong rồi, hai file.', lastFull: 'Đã sửa.\n\n🔊 Xong rồi, **hai** file.' });
  });
  it('blocks the stop with a queued command and lets the next stop through', async () => {
    const dir = fresh();
    writeQueue(dir, 's', 'chạy test rồi commit');
    const out = await handleHook('Stop', { session_id: 's', cwd: 'D:/p', transcript_path: 't' }, { dir, cfg, readFile: () => transcript });
    expect(out).toEqual({ decision: 'block', reason: 'chạy test rồi commit' });
    expect(entry(dir, 's')).toMatchObject({ state: 'working', lastPrompt: 'chạy test rồi commit', lastSpoken: 'Xong rồi, hai file.' });
    expect(entry(dir, 's')!.queued).toBeUndefined();
    // Lượt Stop kế có stop_hook_active vì chính mình chặn: vẫn ghi done.
    const next = await handleHook('Stop', { session_id: 's', cwd: 'D:/p', stop_hook_active: true, transcript_path: 't' }, { dir, cfg, readFile: () => transcript });
    expect(next).toBeUndefined();
    expect(entry(dir, 's')!.state).toBe('done');
    expect(takeFlag(dir, 's', 'ours')).toBe(false);
  });
  it('ignores a stop that another hook blocked', async () => {
    const dir = fresh();
    await handleHook('UserPromptSubmit', { session_id: 's', cwd: 'D:/p', prompt: 'x' }, { dir, cfg });
    const out = await handleHook('Stop', { session_id: 's', cwd: 'D:/p', stop_hook_active: true, transcript_path: 't' }, { dir, cfg, readFile: () => transcript });
    expect(out).toBeUndefined();
    expect(entry(dir, 's')!.state).toBe('working');
  });
  it('survives an unreadable transcript', async () => {
    const dir = fresh();
    await handleHook('Stop', { session_id: 's', cwd: 'D:/p', transcript_path: 'nope' }, { dir, cfg, readFile: () => { throw new Error('ENOENT'); } });
    expect(entry(dir, 's')).toMatchObject({ state: 'done' });
  });
});

describe('PermissionRequest', () => {
  it('records pending with summary and danger, and returns nothing without a decision', async () => {
    const dir = fresh();
    const out = await handleHook('PermissionRequest', { session_id: 's', cwd: 'D:/p', tool_name: 'Bash', tool_input: { command: 'git push' } }, { dir, cfg, wait: async () => undefined });
    expect(out).toBeUndefined();
    expect(entry(dir, 's')).toMatchObject({ state: 'waiting_approve', pending: { kind: 'approve', toolName: 'Bash', summary: 'git push', dangerous: true } });
  });
  it('returns the documented PermissionRequest schema for allow and deny', async () => {
    const dir = fresh();
    const allow = await handleHook('PermissionRequest', { session_id: 's', cwd: 'D:/p', tool_name: 'Bash', tool_input: { command: 'npm test' } }, { dir, cfg, wait: async () => ({ decision: 'allow' }) });
    expect(allow).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(entry(dir, 's')!.state).toBe('working');
    const deny = await handleHook('PermissionRequest', { session_id: 's', cwd: 'D:/p', tool_name: 'Bash', tool_input: { command: 'npm test' } }, { dir, cfg, wait: async () => ({ decision: 'deny' }) });
    expect(deny).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Người dùng từ chối từ trang điều khiển.' } } });
  });
  it('never allows a dangerous command from the web, but still denies', async () => {
    const dir = fresh();
    const allow = await handleHook('PermissionRequest', { session_id: 's', cwd: 'D:/p', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, { dir, cfg, wait: async () => ({ decision: 'allow' }) });
    expect(allow).toBeUndefined();
    expect(entry(dir, 's')!.state).toBe('waiting_approve');
    const deny = await handleHook('PermissionRequest', { session_id: 's', cwd: 'D:/p', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, { dir, cfg, wait: async () => ({ decision: 'deny' }) });
    expect(deny).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  });
});

describe('AskUserQuestion and elicitation', () => {
  const input = {
    session_id: 's', cwd: 'D:/p', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Dùng thư viện nào?', multiSelect: true, options: [{ label: '1. Rust' }, { label: 'Go' }, { label: '' }] }] },
  };
  it('records the question and options without numbering', async () => {
    const dir = fresh();
    expect(await handleHook('PreToolUse', input, { dir, cfg })).toBeUndefined();
    expect(entry(dir, 's')).toMatchObject({ state: 'waiting_answer', pending: { kind: 'question', question: 'Dùng thư viện nào?', options: ['Rust', 'Go'], multiSelect: true } });
  });
  it('answers by index list or free text with a deny reason Claude can act on', async () => {
    const dir = fresh();
    const picked = await handleHook('PreToolUse', input, { dir, cfg, wait: async () => ({ answer: [0, 1] }) });
    expect(picked).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Người dùng đã trả lời từ trang điều khiển, không cần hỏi lại. Câu hỏi "Dùng thư viện nào?": chọn "Rust" và "Go". Hãy làm tiếp theo lựa chọn này.',
      },
    });
    const free = await handleHook('PreToolUse', input, { dir, cfg: { ...cfg, lang: 'en' }, wait: async () => ({ answer: 'neither, use Zig' }) });
    expect((free as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toBe(
      'The user already answered from the control page, do not ask again. Question "Dùng thư viện nào?": answered "neither, use Zig". Continue with this choice.',
    );
    expect(entry(dir, 's')!.state).toBe('working');
  });
  it('ignores other PreToolUse tools and records elicitation dialogs', async () => {
    const dir = fresh();
    expect(await handleHook('PreToolUse', { session_id: 's', cwd: 'D:/p', tool_name: 'Bash' }, { dir, cfg })).toBeUndefined();
    expect(entry(dir, 's')).toBeUndefined();
    await handleHook('Notification', { session_id: 's', cwd: 'D:/p', notification_type: 'elicitation_dialog', message: 'Nhập API key' }, { dir, cfg });
    expect(entry(dir, 's')).toMatchObject({ state: 'waiting_answer', pending: { kind: 'question', question: 'Nhập API key' } });
    await handleHook('Notification', { session_id: 's', cwd: 'D:/p', notification_type: 'idle_prompt' }, { dir, cfg });
    expect(entry(dir, 's')!.state).toBe('waiting_answer');
  });
});

describe('edge cases', () => {
  it('does nothing without a session id or for unknown events', async () => {
    const dir = fresh();
    expect(await handleHook('Stop', { cwd: 'D:/p' }, { dir, cfg })).toBeUndefined();
    expect(await handleHook('SessionStart', { session_id: 's', cwd: 'D:/p' }, { dir, cfg })).toBeUndefined();
    expect(readInbox(dir)).toEqual([]);
    setFlag(dir, 'x', 'ours');
    expect(takeFlag(dir, 'x', 'ours')).toBe(true);
  });
});
