import { describe, it, expect, vi } from 'vitest';
import { transcribe, postProcess, buildPrompt, stripHallucinations, stripContextEcho } from '../src/transcriber';

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

describe('stripHallucinations', () => {
  it('drops well-known Whisper filler sentences', () => {
    expect(stripHallucinations('Cảm ơn các bạn đã theo dõi và hẹn gặp lại')).toBe('');
    expect(stripHallucinations('Hẹn gặp lại. Hẹn gặp lại. Xin cảm ơn.')).toBe('');
  });
  it('keeps real sentences and removes consecutive duplicates', () => {
    expect(stripHallucinations('sửa hàm claimNext. sửa hàm claimNext. rồi chạy test')).toBe('sửa hàm claimNext. rồi chạy test');
    expect(stripHallucinations('cảm ơn bạn, giờ refactor hàm này')).toBe('cảm ơn bạn, giờ refactor hàm này');
  });
});

describe('buildPrompt', () => {
  it('appends the tail of previous transcript to the base prompt', () => {
    const base = buildPrompt();
    expect(buildPrompt('xin chào')).toBe(`${base} xin chào`);
    const long = 'a'.repeat(300);
    expect(buildPrompt(long).endsWith('a'.repeat(150))).toBe(true);
    expect(buildPrompt(long).length).toBe(base.length + 1 + 150);
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
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('prompt')).toBe(buildPrompt());
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

  it('drops segments Whisper marks as no-speech or low confidence', async () => {
    const f = fakeFetch(200, {
      text: 'Cảm ơn các bạn. sửa hàm claimNext. bịa',
      segments: [
        { text: ' Cảm ơn các bạn.', no_speech_prob: 0.9, avg_logprob: -0.3, compression_ratio: 1.2 },
        { text: ' sửa hàm claimNext.', no_speech_prob: 0.1, avg_logprob: -0.4, compression_ratio: 1.3 },
        { text: ' bịa', no_speech_prob: 0.1, avg_logprob: -1.6, compression_ratio: 1.1 },
      ],
    });
    await expect(transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch })).resolves.toBe('sửa hàm claimNext');
  });

  it('returns empty string when Groq gives no text', async () => {
    const f = fakeFetch(200, {});
    await expect(transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch })).resolves.toBe('');
  });
});

describe('stripContextEcho', () => {
  it('drops a sentence Whisper copied from the previous transcript', () => {
    const ctx = 'Cần improve gì nữa ko, khi mình thấy tiếng Việt';
    expect(stripContextEcho('Cần improve gì nữa cơ khi mình thấy tiếng Việt, rồi chạy test', ctx)).toBe('rồi chạy test');
    expect(stripContextEcho('Cần improve gì nữa ko, khi mình thấy tiếng Việt', ctx)).toBe('');
  });
  it('drops a leading word overlap with the context tail', () => {
    expect(stripContextEcho('hàm claimNext rồi chạy test', 'giờ refactor hàm claimNext')).toBe('rồi chạy test');
  });
  it('drops an echo that follows a hallucinated prefix (real sample)', () => {
    const ctx = 'Cần improve gì nữa ko, khi mình thấy tiếng Việt,';
    const raw = 'Cách sử dụng vệ tên sân vô sinh đại hội cho expense of the game Cần improve gì nữa cơ khi mình thấy tiếng Việt,';
    expect(stripContextEcho(raw, ctx)).toBe('Cách sử dụng vệ tên sân vô sinh đại hội cho expense of the game');
  });
  it('keeps text that only shares one or two words', () => {
    expect(stripContextEcho('test lại lần nữa', 'chạy test')).toBe('test lại lần nữa');
    expect(stripContextEcho('sửa hàm này', '')).toBe('sửa hàm này');
  });
});
