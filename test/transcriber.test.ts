import { describe, it, expect, vi } from 'vitest';
import { transcribe, postProcess } from '../src/transcriber';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

const audio = new Uint8Array([1, 2, 3]);

describe('postProcess', () => {
  it('trims and drops one trailing period', () => {
    expect(postProcess('  xin chào. ')).toBe('xin chào');
  });
  it('keeps inner punctuation', () => {
    expect(postProcess('sửa a, rồi b. sau đó c')).toBe('sửa a, rồi b. sau đó c');
  });
});

describe('transcribe', () => {
  it('posts multipart to Groq with bearer key and returns processed text', async () => {
    const f = fakeFetch(200, { text: 'refactor hàm claimNext.' });
    const text = await transcribe(audio, { apiKey: 'gsk_test', fetchFn: f as unknown as typeof fetch });
    expect(text).toBe('refactor hàm claimNext');

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('vi');
    expect(form.get('response_format')).toBe('json');
    expect(typeof form.get('prompt')).toBe('string');
    expect((form.get('file') as File).name).toBe('audio.wav');
  });

  it.each([
    [401, 'auth'],
    [429, 'rate'],
    [500, 'server'],
  ])('maps HTTP %s to kind %s', async (status, kind) => {
    const f = fakeFetch(status, { error: 'x' });
    await expect(
      transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: 'TranscribeError', kind });
  });

  it('maps thrown fetch to kind network', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(
      transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('returns empty string when Groq gives no text', async () => {
    const f = fakeFetch(200, {});
    await expect(transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch })).resolves.toBe('');
  });
});
