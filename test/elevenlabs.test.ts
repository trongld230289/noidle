import { describe, it, expect } from 'vitest';
import { rateToSpeed, elevenRequest, synthElevenLabs, ELEVEN_DEFAULT_VOICE, ELEVEN_DEFAULT_MODEL, fetchUsage, formatUsage, readUsage, writeUsage, usageFilePath, isQuotaError, elevenExhausted } from '../src/elevenlabs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('ElevenLabs: tốc độ từ voiceRate', () => {
  it('+0% là 1, +10% là 1.1, -20% là 0.8', () => {
    expect(rateToSpeed('+0%')).toBe(1);
    expect(rateToSpeed('+10%')).toBeCloseTo(1.1);
    expect(rateToSpeed('-20%')).toBeCloseTo(0.8);
  });
  it('kẹp trong khoảng ElevenLabs cho phép 0.7..1.2', () => {
    expect(rateToSpeed('+50%')).toBe(1.2);
    expect(rateToSpeed('-50%')).toBe(0.7);
  });
  it('giá trị lạ thì 1', () => {
    expect(rateToSpeed('')).toBe(1);
    expect(rateToSpeed('fast')).toBe(1);
  });
});

describe('ElevenLabs: yêu cầu HTTP', () => {
  it('gọi đúng endpoint theo voice, header xi-api-key, mp3 24kHz như Edge', () => {
    const r = elevenRequest({ apiKey: 'sk-test', voiceId: 'abc123', model: 'eleven_flash_v2_5', text: 'Xin chào', speed: 1.1 });
    expect(r.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=mp3_24000_48');
    expect(r.init.method).toBe('POST');
    expect((r.init.headers as Record<string, string>)['xi-api-key']).toBe('sk-test');
    const body = JSON.parse(r.init.body as string);
    expect(body).toMatchObject({ text: 'Xin chào', model_id: 'eleven_flash_v2_5', voice_settings: { speed: 1.1 } });
  });
  it('mặc định là giọng George và model Flash v2.5', () => {
    expect(ELEVEN_DEFAULT_VOICE).toBe('JBFqnCBsd6RMkjVDRZzb');
    expect(ELEVEN_DEFAULT_MODEL).toBe('eleven_flash_v2_5');
    const r = elevenRequest({ apiKey: 'k', text: 'a', speed: 1 });
    expect(r.url).toContain(ELEVEN_DEFAULT_VOICE);
    expect(JSON.parse(r.init.body as string).model_id).toBe(ELEVEN_DEFAULT_MODEL);
  });
});

describe('ElevenLabs: tổng hợp', () => {
  const ok = (bytes: Buffer): typeof fetch =>
    (async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as unknown as typeof fetch;

  it('trả về audio khi 200', async () => {
    const audio = await synthElevenLabs({ apiKey: 'k', text: 'hi', speed: 1 }, ok(Buffer.from('MP3DATA')));
    expect(audio.toString()).toBe('MP3DATA');
  });

  it('200 mà rỗng thì lỗi', async () => {
    await expect(synthElevenLabs({ apiKey: 'k', text: 'hi', speed: 1 }, ok(Buffer.alloc(0)))).rejects.toThrow(/không trả audio/);
  });

  it('lỗi 401 nêu rõ key sai, 402/quota nêu hết credit, kèm status của ElevenLabs', async () => {
    const err = (status: number, body: unknown): typeof fetch =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(
      synthElevenLabs({ apiKey: 'bad', text: 'hi', speed: 1 }, err(401, { detail: { status: 'invalid_api_key', message: 'nope' } })),
    ).rejects.toThrow(/401.*invalid_api_key/);
    await expect(
      synthElevenLabs({ apiKey: 'k', text: 'hi', speed: 1 }, err(402, { detail: { status: 'quota_exceeded', message: 'x' } })),
    ).rejects.toThrow(/402.*quota_exceeded/);
    await expect(synthElevenLabs({ apiKey: 'k', text: 'hi', speed: 1 }, err(500, 'oops'))).rejects.toThrow(/500/);
  });

  it('không có key thì báo ngay, không gọi mạng', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('x');
    }) as unknown as typeof fetch;
    await expect(synthElevenLabs({ apiKey: '', text: 'hi', speed: 1 }, spy)).rejects.toThrow(/API key/);
    expect(called).toBe(false);
  });
});

describe('ElevenLabs: credit còn lại', () => {
  const sub = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('fetchUsage đọc /v1/user/subscription: đã dùng, hạn mức, ngày reset', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ tier: 'free', character_count: 3524, character_limit: 10000, next_character_count_reset_unix: 1_760_000_000 }));
    }) as unknown as typeof fetch;
    const u = await fetchUsage('k', f);
    expect(url).toBe('https://api.elevenlabs.io/v1/user/subscription');
    expect(u).toEqual({ used: 3524, limit: 10000, resetAt: 1_760_000_000_000, tier: 'free', at: expect.any(Number) });
  });

  it('fetchUsage lỗi HTTP thì ném lỗi có mã', async () => {
    await expect(fetchUsage('k', sub({ detail: { status: 'missing_permissions' } }, 401))).rejects.toThrow(/401.*missing_permissions/);
  });

  it('formatUsage: còn lại gọn cho status bar', () => {
    expect(formatUsage({ used: 3524, limit: 10000, resetAt: 0, tier: 'free', at: 0 })).toBe('6.5k/10k');
    expect(formatUsage({ used: 0, limit: 30000, resetAt: 0, tier: 'starter', at: 0 })).toBe('30k/30k');
    expect(formatUsage({ used: 9950, limit: 10000, resetAt: 0, tier: 'free', at: 0 })).toBe('50/10k');
    expect(formatUsage({ used: 10000, limit: 10000, resetAt: 0, tier: 'free', at: 0 })).toBe('0/10k');
  });

  it('writeUsage/readUsage đi qua file trong thư mục tạm của hook', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-usage-'));
    const file = path.join(dir, 'u.json');
    const u = { used: 1, limit: 2, resetAt: 3, tier: 'free', at: 4 };
    writeUsage(u, file);
    expect(readUsage(file)).toEqual(u);
    expect(readUsage(path.join(dir, 'missing.json'))).toBeUndefined();
    fs.writeFileSync(file, 'not json');
    expect(readUsage(file)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(usageFilePath()).toBe(path.join(os.tmpdir(), 'noidle-tts', 'elevenlabs-usage.json'));
  });
});

describe('ElevenLabs: hết credit thì đi thẳng Edge, không gọi lại mỗi câu', () => {
  const usage = (used: number, resetAt: number) => ({ used, limit: 10000, resetAt, tier: 'free', at: 1 });
  const now = 1_000_000;

  it('isQuotaError nhận ra lỗi quota_exceeded của ElevenLabs, không nhận lỗi khác', () => {
    expect(isQuotaError(new Error('ElevenLabs 401 quota_exceeded: This request exceeds your quota of 10000.'))).toBe(true);
    expect(isQuotaError(new Error('ElevenLabs 401 invalid_api_key'))).toBe(false);
    expect(isQuotaError(new Error('fetch failed'))).toBe(false);
  });

  it('elevenExhausted: credit còn lại ít hơn số ký tự của câu và chưa tới kỳ reset', () => {
    expect(elevenExhausted(usage(9998, now + 1000), 12, now)).toBe(true);
    expect(elevenExhausted(usage(9000, now + 1000), 12, now)).toBe(false);
  });

  it('elevenExhausted: qua mốc reset thì thử lại ElevenLabs, chưa có số liệu thì cũng thử', () => {
    expect(elevenExhausted(usage(9998, now - 1), 12, now)).toBe(false);
    expect(elevenExhausted(undefined, 12, now)).toBe(false);
  });

  it('elevenExhausted: không biết mốc reset thì coi như còn hết trong 24 giờ kể từ lúc lấy số liệu', () => {
    const u = { ...usage(9998, 0), at: now };
    expect(elevenExhausted(u, 12, now + 3_600_000)).toBe(true);
    expect(elevenExhausted(u, 12, now + 25 * 3_600_000)).toBe(false);
  });
});
