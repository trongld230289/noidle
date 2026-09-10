import { describe, it, expect, vi } from 'vitest';
import { refine, cleanReply, keepsMostWords } from '../src/refiner';

function fakeFetch(status: number, content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('cleanReply', () => {
  it('strips wrapping quotes and whitespace', () => {
    expect(cleanReply(' "sửa hàm claimNext" ', 'sua ham claimNext')).toBe('sửa hàm claimNext');
  });
  it('returns empty for the drop sentinel', () => {
    expect(cleanReply('[BỎ]', 'bla bla')).toBe('');
  });
  it('falls back to input when reply is empty or suspiciously long', () => {
    expect(cleanReply('', 'giữ nguyên')).toBe('giữ nguyên');
    expect(cleanReply('a'.repeat(200), 'ngắn')).toBe('ngắn');
  });
});

describe('keepsMostWords', () => {
  it('accepts diacritic fixes and phonetic merges', () => {
    expect(keepsMostWords('du ai tạo label moi', 'UI tạo label mới')).toBe(true);
    expect(keepsMostWords('sua ham claimNext', 'Sửa hàm claimNext.')).toBe(true);
  });
  it('rejects rewrites that drop or replace most words', () => {
    expect(keepsMostWords('impact không', 'bug')).toBe(false);
    expect(keepsMostWords('có bị', 'có bị bug hay không nhỉ')).toBe(false);
  });
  it('cleanReply falls back to input on such rewrites', () => {
    expect(cleanReply('bug', 'impact không')).toBe('impact không');
  });
});

describe('refine', () => {
  it('posts a chat completion and returns the corrected text', async () => {
    const f = fakeFetch(200, 'Cần improve gì nữa không?');
    const out = await refine('cần improve gì nữa ko', {
      apiKey: 'gsk_test',
      target: 'chat',
      context: 'trước đó',
      fetchFn: f as unknown as typeof fetch,
    });
    expect(out).toBe('Cần improve gì nữa không?');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.at(-1).content).toContain('cần improve gì nữa ko');
  });

  it('falls back to the raw text on HTTP error or network failure', async () => {
    const bad = fakeFetch(500, 'x');
    expect(await refine('giữ nguyên', { apiKey: 'k', target: 'editor', fetchFn: bad as unknown as typeof fetch })).toBe('giữ nguyên');
    const thrown = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await refine('giữ nguyên', { apiKey: 'k', target: 'editor', fetchFn: thrown as unknown as typeof fetch })).toBe('giữ nguyên');
  });

  it('passes the user glossary to the model', async () => {
    const f = fakeFetch(200, 'ok');
    await refine('ok', { apiKey: 'k', target: 'chat', glossary: ['claimNext', 'Vi Voice'], fetchFn: f as unknown as typeof fetch });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages.at(-1).content).toContain('claimNext, Vi Voice');
  });

  it('honours a custom model', async () => {
    const f = fakeFetch(200, 'ok');
    await refine('ok', { apiKey: 'k', target: 'terminal', model: 'llama-3.1-8b-instant', fetchFn: f as unknown as typeof fetch });
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe('llama-3.1-8b-instant');
  });
});
