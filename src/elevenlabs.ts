/**
 * Giọng đọc ElevenLabs (tuỳ chọn thay Edge TTS). Gói miễn phí: 10.000 credit mỗi tháng, có API;
 * Flash v2.5 tính nửa credit một ký tự (khoảng 20.000 ký tự), Multilingual v2 và v3 tính một credit một ký tự.
 * Trả về MP3 24kHz 48kbps như Edge để đường ống ffplay của hook không đổi.
 * Không dùng vscode để hook (tiến trình riêng) cũng import được.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * George, giọng có sẵn của ElevenLabs: gói Free gọi được qua API và đọc trộn Việt Anh trong một câu.
 * Giọng Voice Library (Nhật Phong 6adFm46eyy74snVn6YrT...) gói Free bị 402 "Free users cannot use library voices via
 * the API", chỉ dùng được từ Starter (đã thử 2026-09-24).
 */
export const ELEVEN_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
/** Rẻ nhất và nhanh nhất, đọc được tiếng Việt lẫn tiếng Anh trong một câu. */
export const ELEVEN_DEFAULT_MODEL = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'mp3_24000_48';
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;

export interface ElevenOptions {
  apiKey: string;
  text: string;
  /** voice_settings.speed, 0.7..1.2; dùng rateToSpeed để đổi từ noIdle.voiceRate. */
  speed: number;
  voiceId?: string;
  model?: string;
  /** Quá lâu thì huỷ yêu cầu để hook không treo; mặc định không giới hạn. */
  timeoutMs?: number;
}

/** noIdle.voiceRate kiểu Edge ("+10%", "-20%") đổi sang speed của ElevenLabs, kẹp trong khoảng cho phép. */
export function rateToSpeed(rate: string): number {
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*%\s*$/.exec(rate ?? '');
  if (!m) return 1;
  const speed = 1 + Number(m[1]) / 100;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}

export function elevenRequest(o: ElevenOptions): { url: string; init: RequestInit } {
  const voice = o.voiceId || ELEVEN_DEFAULT_VOICE;
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': o.apiKey },
      body: JSON.stringify({
        text: o.text,
        model_id: o.model || ELEVEN_DEFAULT_MODEL,
        voice_settings: { speed: o.speed },
      }),
    },
  };
}

/** Một yêu cầu tổng hợp. Lỗi HTTP kèm status của ElevenLabs (invalid_api_key, quota_exceeded...) để log dễ hiểu. */
export async function synthElevenLabs(o: ElevenOptions, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  if (!o.apiKey) throw new Error('chưa có ElevenLabs API key (noIdle.elevenLabsApiKey)');
  const { url, init } = elevenRequest(o);
  if (o.timeoutMs) init.signal = AbortSignal.timeout(o.timeoutMs);
  const res = await fetchFn(url, init);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: { status?: string; message?: string } | string };
      detail = typeof body.detail === 'string' ? body.detail : [body.detail?.status, body.detail?.message].filter(Boolean).join(': ');
    } catch {
      /* body không phải JSON */
    }
    throw new Error(`ElevenLabs ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('ElevenLabs không trả audio');
  return audio;
}

/** Credit của tài khoản, hook ghi ra file sau mỗi lượt đọc để extension hiện trên status bar (không đọc thành tiếng). */
export interface ElevenUsage {
  used: number;
  limit: number;
  /** Mốc reset hạn mức tháng, ms epoch; 0 nếu không có. */
  resetAt: number;
  tier: string;
  /** Lúc lấy số liệu, ms epoch. */
  at: number;
}

export async function fetchUsage(apiKey: string, fetchFn: typeof fetch = fetch): Promise<ElevenUsage> {
  const res = await fetchFn('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { detail?: { status?: string } | string };
      detail = typeof body.detail === 'string' ? body.detail : body.detail?.status ?? '';
    } catch {
      /* bỏ qua */
    }
    throw new Error(`ElevenLabs ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  const d = (await res.json()) as { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
  return {
    used: d.character_count ?? 0,
    limit: d.character_limit ?? 0,
    resetAt: d.next_character_count_reset_unix ? d.next_character_count_reset_unix * 1000 : 0,
    tier: d.tier ?? '',
    at: Date.now(),
  };
}

function short(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** "6.5k/10k": còn lại trên hạn mức, đủ gọn cho status bar. */
export function formatUsage(u: ElevenUsage): string {
  return `${short(Math.max(0, u.limit - u.used))}/${short(u.limit)}`;
}

/** Lỗi ElevenLabs báo hết credit (401/402 quota_exceeded). */
export function isQuotaError(err: unknown): boolean {
  return /quota_exceeded/i.test(err instanceof Error ? err.message : String(err));
}

/** Không biết mốc reset thì coi số liệu "hết credit" còn giá trị bấy nhiêu lâu rồi mới thử lại ElevenLabs. */
const EXHAUSTED_TTL_MS = 24 * 3_600_000;

/**
 * Đã hết credit cho câu này chưa (credit tính xấp xỉ theo ký tự). Có thì hook đi thẳng Edge, không gọi ElevenLabs
 * hai lần lỗi rồi mới lùi như trước. Qua mốc reset (hoặc 24 giờ nếu không biết mốc) thì thử lại để nhận credit mới.
 */
export function elevenExhausted(u: ElevenUsage | undefined, textLength: number, now = Date.now()): boolean {
  if (!u) return false;
  if (u.limit - u.used >= textLength) return false;
  const until = u.resetAt || u.at + EXHAUSTED_TTL_MS;
  return now < until;
}

export function usageFilePath(): string {
  return path.join(os.tmpdir(), 'noidle-tts', 'elevenlabs-usage.json');
}

export function writeUsage(u: ElevenUsage, file = usageFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(u));
}

export function readUsage(file = usageFilePath()): ElevenUsage | undefined {
  try {
    const u = JSON.parse(fs.readFileSync(file, 'utf8')) as ElevenUsage;
    return typeof u.limit === 'number' && typeof u.used === 'number' ? u : undefined;
  } catch {
    return undefined;
  }
}
