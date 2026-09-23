import { describe, it, expect, vi } from 'vitest';
import { transcribe, postProcess, buildPrompt, stripHallucinations, stripContextEcho, repeatsTail } from '../src/transcriber';

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
  it('drops the English fillers Whisper invents on keyboard noise or silence (real hands-free log 2026-09-23)', () => {
    expect(stripHallucinations('Thank you.')).toBe('');
    expect(stripHallucinations('Thank you. Thank you. Thank you.')).toBe('');
    expect(stripHallucinations('Thanks for watching!')).toBe('');
    expect(stripHallucinations('Thank you for watching. Bye.')).toBe('');
    expect(stripHallucinations('Please subscribe to my channel')).toBe('');
    expect(stripHallucinations('you')).toBe('');
    expect(stripHallucinations('.')).toBe('');
  });
  it('keeps English sentences that merely contain thanks', () => {
    expect(stripHallucinations('thank you, now refactor this function')).toBe('thank you, now refactor this function');
    expect(stripHallucinations('add a thank you page after checkout')).toBe('add a thank you page after checkout');
  });
  it('keeps real sentences and removes consecutive duplicates', () => {
    expect(stripHallucinations('sửa hàm claimNext. sửa hàm claimNext. rồi chạy test')).toBe('sửa hàm claimNext. rồi chạy test');
    expect(stripHallucinations('cảm ơn bạn, giờ refactor hàm này')).toBe('cảm ơn bạn, giờ refactor hàm này');
  });
});

describe('repeatsTail', () => {
  it('true when a short new chunk just repeats the end of what was already typed', () => {
    expect(repeatsTail('Thank you', 'Thank you')).toBe(true);
    expect(repeatsTail('sửa hàm này. Thank you', ' thank you.')).toBe(true);
    expect(repeatsTail('ok ok', 'OK')).toBe(true);
  });
  it('false for new content, for the first chunk, and for long chunks even if repeated', () => {
    expect(repeatsTail('', 'Thank you')).toBe(false);
    expect(repeatsTail('Thank you', 'now run the tests')).toBe(false);
    expect(repeatsTail('chạy test rồi build lại toàn bộ project', 'chạy test rồi build lại toàn bộ project')).toBe(false);
  });
});

describe('buildPrompt', () => {
  it('appends the user glossary to the base prompt', () => {
    expect(buildPrompt(['claimNext', ' NoIdle ', ''])).toBe(`${buildPrompt()} Project này có claimNext, NoIdle.`);
    expect(buildPrompt([])).toBe(buildPrompt());
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

  it('does not use previous transcript as prompt, so a repeated sentence survives', async () => {
    const f = fakeFetch(200, { text: 'sửa hàm claimNext rồi chạy test' });
    const text = await transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch });
    expect(text).toBe('sửa hàm claimNext rồi chạy test');
    const form = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('prompt')).toBe(buildPrompt());
  });

  it('drops the prompt sentence when Whisper echoes it on silence', async () => {
    const f = fakeFetch(200, { text: `${buildPrompt()} rồi chạy test` });
    const text = await transcribe(audio, { apiKey: 'k', fetchFn: f as unknown as typeof fetch });
    expect(text).toBe('rồi chạy test');
  });

  it('omits language when set to empty so Whisper auto-detects', async () => {
    const f = fakeFetch(200, { text: 'ok' });
    await transcribe(audio, { apiKey: 'k', language: '', fetchFn: f as unknown as typeof fetch });
    const form = (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('language')).toBeNull();
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
