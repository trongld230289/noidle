import { describe, it, expect, vi } from 'vitest';
import { refine, cleanReply, keepsMostWords, resetRefinePause, parseResetSeconds } from '../src/refiner';

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
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.reasoning_effort).toBe('low');
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

  it('reports a missing model (HTTP 404) through onError and still returns the raw text', async () => {
    const gone = fakeFetch(404, '');
    const errors: string[] = [];
    const out = await refine('giữ nguyên', { apiKey: 'k', target: 'editor', model: 'llama-3.3-70b-versatile', fetchFn: gone as unknown as typeof fetch, onError: (m) => void errors.push(m) });
    expect(out).toBe('giữ nguyên');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('llama-3.3-70b-versatile');
    expect(errors[0]).toContain('không tồn tại');
  });

  it('passes the user glossary to the model', async () => {
    const f = fakeFetch(200, 'ok');
    await refine('ok', { apiKey: 'k', target: 'chat', glossary: ['claimNext', 'Vi Voice'], fetchFn: f as unknown as typeof fetch });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages.at(-1).content).toContain('claimNext, Vi Voice');
  });

  it('honours a custom model', async () => {
    const f = fakeFetch(200, 'ok');
    await refine('ok', { apiKey: 'k', target: 'terminal', model: 'openai/gpt-oss-20b', fetchFn: f as unknown as typeof fetch });
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe('openai/gpt-oss-20b');
  });
});

describe('refine prompt size', () => {
  it('keeps the whole request under ~1.300 characters for a typical chunk so Groq free tier lasts ~100 sentences a day', async () => {
    const f = fakeFetch(200, 'ok');
    await refine('chạy unit test lại coi pass hết chưa', {
      apiKey: 'k',
      target: 'terminal',
      context: 'sửa xong rồi',
      glossary: ['claimNext', 'order view'],
      fetchFn: f as unknown as typeof fetch,
    });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const total = body.messages.reduce((n: number, m: { content: string }) => n + m.content.length, 0);
    expect(total).toBeLessThan(1300);
  });
});

describe('refine pause after HTTP 429', () => {
  function fetch429(headers: Record<string, string>) {
    return vi.fn(async () => new Response('', { status: 429, headers }));
  }

  it('skips Groq for the rest of the speech session (or until the reset time), reporting once', async () => {
    resetRefinePause();
    let now = 1_000_000;
    const errors: string[] = [];
    const f = fetch429({ 'retry-after': '120' });
    const base = { apiKey: 'k', target: 'chat' as const, fetchFn: f as unknown as typeof fetch, now: () => now, onError: (m: string) => void errors.push(m) };
    expect(await refine('một', base)).toBe('một');
    expect(await refine('hai', base)).toBe('hai');
    expect(await refine('ba', base)).toBe('ba');
    expect(f).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('lượt nói này');
    // Lượt nói mới (F6 hoặc hands-free mở mic lại) thử Groq ngay, không đợi giờ reset: lỡ vừa nạp tiền thì dùng được liền.
    resetRefinePause();
    await refine('bốn', base);
    expect(f).toHaveBeenCalledTimes(2);
    // Trong cùng lượt, quá giờ reset Groq báo thì cũng tự thử lại.
    now += 121_000;
    await refine('năm', base);
    expect(f).toHaveBeenCalledTimes(3);
    resetRefinePause();
  });

  it('understands Groq reset headers like 2m59.56s and falls back to 60s when absent', () => {
    expect(parseResetSeconds({ 'x-ratelimit-reset-tokens': '2m59.56s' })).toBeCloseTo(179.56, 1);
    expect(parseResetSeconds({ 'x-ratelimit-reset-requests': '1h2m' })).toBe(3720);
    expect(parseResetSeconds({ 'retry-after': '45' })).toBe(45);
    expect(parseResetSeconds({})).toBe(60);
  });
});
