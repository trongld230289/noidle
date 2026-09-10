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
  /** Thuật ngữ riêng của người dùng, đưa vào prompt để Whisper viết đúng. */
  glossary?: string[];
  /** Nhận chữ thô của Whisper trước khi lọc, để ghi log. */
  onRaw?: (raw: string) => void;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';
// Gợi ý ngữ cảnh để Whisper giữ nguyên thuật ngữ và chữ viết tắt tiếng Anh thay vì phiên âm
// (UI thành "du ai", API thành "ây pi ai"). Whisper chỉ đọc ~224 token cuối nên phải ngắn.
const PROMPT =
  'Mình sửa UI, gọi API, đọc JSON, viết CSS, HTML, SQL, dùng React hook, TypeScript, Node, ' +
  'git commit, push, merge branch, tạo PR, chạy unit test, build, deploy, fix bug, refactor function, ' +
  'config, log, debug, AI, ID, URL, DB, CI, VS Code, Copilot, Claude.';

const MAX_CONTEXT_CHARS = 100;

export function contextTail(context?: string): string {
  return (context ?? '').trim().slice(-MAX_CONTEXT_CHARS);
}

/** Prompt cho Whisper: thuật ngữ mặc định, từ điển của người dùng, rồi đuôi chữ đã nhận. */
export function buildPrompt(context?: string, glossary: string[] = []): string {
  const terms = glossary.map((t) => t.trim()).filter(Boolean);
  const head = terms.length ? `${PROMPT} ${terms.join(', ')}.` : PROMPT;
  const tail = contextTail(context);
  return tail ? `${head} ${tail}` : head;
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
  form.append('prompt', buildPrompt(opts.context, opts.glossary));

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
  opts.onRaw?.(data.text ?? '');
  const raw = stripHallucinations(joinConfidentSegments(data));
  return postProcess(stripContextEcho(raw, contextTail(opts.context)));
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

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whisper hay chép lại đoạn cuối của prompt (chữ đã nhận ở cụm trước) vào kết quả.
 * Tìm đoạn dài nhất trong text khớp (>= 80% từ, đúng thứ tự) với context rồi bỏ đi.
 * Đoạn >= 4 từ bị bỏ ở bất kỳ vị trí nào; đoạn 2-3 từ chỉ bị bỏ khi nằm ở đầu text
 * và khớp đúng đuôi của context (Whisper nối tiếp prompt).
 */
export function stripContextEcho(text: string, context: string): string {
  const tokens = words(text);
  const ctx = words(context).map(normalizeWord).filter(Boolean);
  if (tokens.length === 0 || ctx.length === 0) return text;

  // Căn tham lam: mỗi từ của text tìm lần xuất hiện tiếp theo trong context.
  const at: number[] = new Array(tokens.length).fill(-1);
  let j = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = normalizeWord(tokens[i]);
    if (!w) continue;
    const k = ctx.indexOf(w, j);
    if (k >= 0) {
      at[i] = k;
      j = k + 1;
    }
  }

  let best: { start: number; end: number } | undefined;
  for (let start = 0; start < tokens.length; start++) {
    if (at[start] < 0) continue;
    let hit = 0;
    for (let end = start; end < tokens.length; end++) {
      if (at[end] >= 0) hit++;
      const len = end - start + 1;
      if (at[end] >= 0 && hit / len >= 0.8 && (!best || len > best.end - best.start + 1)) best = { start, end };
    }
  }
  if (!best) return text;
  const len = best.end - best.start + 1;
  const continuesPrompt = best.start === 0 && at[best.end] === ctx.length - 1;
  if (len < 4 && !(continuesPrompt && len >= 2)) return text;
  return [...tokens.slice(0, best.start), ...tokens.slice(best.end + 1)].join(' ');
}
