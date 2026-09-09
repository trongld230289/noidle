export type TranscribeErrorKind = 'auth' | 'rate' | 'network' | 'server';

export class TranscribeError extends Error {
  constructor(public readonly kind: TranscribeErrorKind, message: string) {
    super(message);
    this.name = 'TranscribeError';
  }
}

export interface TranscribeOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Chữ đã nhận ở các cụm trước, để Whisper nối câu đúng. */
  context?: string;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';
// Gợi ý ngữ cảnh để Whisper giữ nguyên thuật ngữ lập trình tiếng Anh.
const PROMPT =
  'Tôi cần refactor function claimNext, rồi commit và tạo pull request. ' +
  'Component này dùng React hook, gọi API endpoint trả về JSON, viết unit test bằng vitest.';

const MAX_CONTEXT_CHARS = 150;

export function buildPrompt(context?: string): string {
  const tail = (context ?? '').trim().slice(-MAX_CONTEXT_CHARS);
  return tail ? `${PROMPT} ${tail}` : PROMPT;
}

export function postProcess(text: string): string {
  return text.trim().replace(/\.$/u, '');
}

export async function transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const form = new FormData();
  form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', MODEL);
  form.append('language', 'vi');
  form.append('response_format', 'verbose_json');
  form.append('prompt', buildPrompt(opts.context));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetchFn(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    throw new TranscribeError('network', `Không gọi được Groq: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new TranscribeError('auth', 'Groq API key không hợp lệ');
  if (res.status === 429) throw new TranscribeError('rate', 'Groq đang giới hạn, thử lại sau vài giây');
  if (!res.ok) throw new TranscribeError('server', `Groq trả lỗi HTTP ${res.status}`);

  const data = (await res.json()) as GroqVerbose;
  return postProcess(stripHallucinations(joinConfidentSegments(data)));
}

interface GroqSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}
interface GroqVerbose {
  text?: string;
  segments?: GroqSegment[];
}

const MAX_NO_SPEECH_PROB = 0.5;
const MIN_AVG_LOGPROB = -1.2;
const MAX_COMPRESSION_RATIO = 2.4;

/** Ghép các segment Whisper tự tin là có tiếng nói; bỏ segment bịa. */
export function joinConfidentSegments(data: GroqVerbose): string {
  if (!data.segments?.length) return data.text ?? '';
  return data.segments
    .filter(
      (s) =>
        (s.no_speech_prob ?? 0) <= MAX_NO_SPEECH_PROB &&
        (s.avg_logprob ?? 0) >= MIN_AVG_LOGPROB &&
        (s.compression_ratio ?? 1) <= MAX_COMPRESSION_RATIO,
    )
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');
}

// Câu Whisper hay bịa khi audio im lặng hoặc chỉ có tiếng ồn (tiếng Việt).
const HALLUCINATIONS = [
  /^cảm ơn (các bạn|quý vị|mọi người|bạn)( đã (theo dõi|xem|lắng nghe|đón xem))?( và hẹn gặp lại.*)?$/u,
  /^hẹn gặp lại( các bạn| quý vị)?( (trong|ở) (video|tập|chương trình|kỳ)( sau| tiếp theo| tới)?)?$/u,
  /^xin cảm ơn( các bạn| quý vị)?( đã (theo dõi|xem|lắng nghe))?$/u,
  /^(hãy |nhớ )?(đăng ký|subscribe)( kênh)?.*$/u,
  /^chúc (các bạn|quý vị|mọi người) .*$/u,
  /^tạm biệt( các bạn| quý vị)?$/u,
  /^(âm nhạc|nhạc|tiếng nhạc|music)$/u,
];

function normalize(sentence: string): string {
  return sentence.trim().toLowerCase().replace(/[.!?…,]+$/u, '').replace(/\s+/g, ' ');
}

/** Bỏ các câu bịa quen thuộc và câu lặp liên tiếp. */
export function stripHallucinations(text: string): string {
  const sentences = text.split(/(?<=[.!?…])\s+/u).map((x) => x.trim()).filter(Boolean);
  const kept: string[] = [];
  let prev = '';
  for (const sentence of sentences) {
    const n = normalize(sentence);
    if (!n) continue;
    if (HALLUCINATIONS.some((re) => re.test(n))) continue;
    if (n === prev) continue;
    kept.push(sentence);
    prev = n;
  }
  return kept.join(' ');
}
