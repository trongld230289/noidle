import { describe, it, expect, vi } from 'vitest';
import { announcement, workspaceName, spoken } from '../src/speech';
import { recapInstruction } from '../src/recapPrompt';
import { parseVoiceCommand } from '../src/decision';
import { buildPrompt, transcribe } from '../src/transcriber';
import { refine, cleanReply } from '../src/refiner';
import { pronounce } from '../src/pronounce';

/** Chế độ tiếng Anh: mọi câu hook nói ra, prompt cho Claude, Whisper và LLM sửa câu đều đổi theo noIdle.language. */

describe('announcement in English', () => {
  it('announces in English with an English unnamed-workspace fallback', () => {
    expect(workspaceName('', 'en')).toBe('unnamed');
    expect(announcement({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: 'D:/abc' }, 'en')).toBe('Workspace abc needs approval.');
    expect(announcement({ hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: '/x/abc' }, 'en')).toBe('Workspace abc needs approval.');
    expect(announcement({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: '/x/123' }, 'en')).toBe('Workspace 123 needs your answer.');
    expect(announcement({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', cwd: '/x/123' }, 'en')).toBe('Workspace 123 needs your answer.');
    expect(announcement({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', cwd: '/x/abc' }, 'en')).toBe('');
  });
  it('defaults to Vietnamese when no language is given', () => {
    expect(announcement({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: 'D:/abc' })).toBe('Workspace abc cần approve.');
  });
});

describe('prompt instructions', () => {
  it('gives Claude English instructions that still use the speak mark', () => {
    const full = recapInstruction(undefined, 'en');
    expect(full).toContain('🔊');
    expect(full).toMatch(/English/);
    expect(full).not.toMatch(/tiếng Việt/);
    expect(recapInstruction(undefined, 'vi')).toMatch(/tiếng Việt/);
  });
});

describe('spoken hook phrases', () => {
  it('has every phrase in both languages', () => {
    const vi = spoken('vi');
    const en = spoken('en');
    expect(Object.keys(en).sort()).toEqual(Object.keys(vi).sort());
    expect(en.approved).toBe('Approved.');
    expect(vi.approved).toBe('Đã approve.');
    expect(en.sayApproveOrDeny('Workspace abc needs approval.')).toBe('Workspace abc needs approval. After the beep, say approve or deny.');
    expect(en.chosen(['Rust', 'Go'])).toBe('Chose Rust and Go.');
    expect(vi.chosen(['Rust', 'Go'])).toBe('Chọn Rust và Go.');
    expect(en.chooseReason(['Question "Which?": chose "Rust"'])).toMatch(/already answered by voice/);
    expect(en.approveReason('allow', 'yes please')).toBe('User approved by voice: "yes please"');
    expect(vi.approveReason('deny', 'không')).toBe('Người dùng từ chối bằng giọng nói: "không"');
  });
});

describe('parseVoiceCommand in English', () => {
  it('cancels on English stop words said alone', () => {
    for (const w of ['cancel', 'Stop.', 'never mind', 'nevermind', 'forget it']) expect(parseVoiceCommand(w).command).toBe('cancel');
  });
  it('does not cancel when the words are part of a sentence', () => {
    expect(parseVoiceCommand('stop the dev server')).toEqual({ text: 'stop the dev server' });
    expect(parseVoiceCommand('cancel the subscription flow, send')).toEqual({ command: 'send', text: 'cancel the subscription flow' });
  });
});

function fakeJson(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}
const audio = new Uint8Array([82, 73, 70, 70]);

describe('Whisper prompt in English', () => {
  it('uses an English priming sentence and glossary suffix', () => {
    const base = buildPrompt([], 'en');
    expect(base).toMatch(/^I'm /);
    expect(base).not.toMatch(/Mình|đọc|tạo/);
    expect(buildPrompt(['claimNext'], 'en')).toBe(`${base} This project has claimNext.`);
    expect(buildPrompt()).toBe(buildPrompt([], 'vi'));
  });
  it('sends the English prompt when language is en', async () => {
    const f = fakeJson(200, { text: 'ok' });
    await transcribe(audio, { apiKey: 'k', language: 'en', fetchFn: f as unknown as typeof fetch });
    const form = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe(buildPrompt([], 'en'));
  });
});

describe('refine in English', () => {
  it('sends an English system prompt and English labels', async () => {
    const f = fakeJson(200, { choices: [{ message: { content: 'ok' } }] });
    await refine('ok', { apiKey: 'k', target: 'chat', language: 'en', glossary: ['claimNext'], context: 'earlier words', fetchFn: f as unknown as typeof fetch });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toMatch(/English/);
    expect(body.messages[0].content).not.toMatch(/tiếng Việt|dấu thanh/);
    const user = body.messages.at(-1).content as string;
    expect(user).toMatch(/Terms the user often says/);
    expect(user).toContain('claimNext');
    expect(user).toContain('earlier words');
    expect(user).toMatch(/Text to fix:\nok$/);
  });
  it('treats the English drop sentinel as empty', () => {
    expect(cleanReply('[DROP]', 'bla bla')).toBe('');
  });
});

describe('pronounce without the Vietnamese default table', () => {
  it('leaves terms as written but still applies the user table', () => {
    expect(pronounce('read README.md and call the API', undefined, false)).toBe('read README.md and call the API');
    expect(pronounce('acme calls the API', { acme: 'acme shop' }, false)).toBe('acme shop calls the API');
  });
});

describe('Whisper detected language', () => {
  it('reports the language Whisper detected via onLanguage', async () => {
    const f = fakeJson(200, { text: 'run the tests', language: 'english' });
    const seen: string[] = [];
    await transcribe(audio, { apiKey: 'k', language: '', fetchFn: f as unknown as typeof fetch, onLanguage: (l) => void seen.push(l) });
    expect(seen).toEqual(['english']);
  });
});
