import { langOf, isAuto, type Lang } from './lang';

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
  /** Thuật ngữ riêng của người dùng, đưa vào prompt để Whisper viết đúng. */
  glossary?: string[];
  /** Mã ngôn ngữ cho Whisper (mặc định 'vi'). Rỗng hoặc 'auto' = để Whisper tự nhận diện. */
  language?: string;
  /** Ngôn ngữ của câu mồi khi language là auto/rỗng; mặc định suy từ language. */
  promptLang?: Lang;
  /** Nhận chữ thô của Whisper trước khi lọc, để ghi log. */
  onRaw?: (raw: string) => void;
  /** Ngôn ngữ Whisper nhận diện (verbose_json trả tên đầy đủ như "english"), dùng khi setting là auto. */
  onLanguage?: (language: string) => void;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';
// Gợi ý ngữ cảnh để Whisper giữ nguyên thuật ngữ và chữ viết tắt tiếng Anh thay vì phiên âm
// (UI thành "du ai", API thành "ây pi ai"). Whisper chỉ đọc ~224 token cuối nên phải ngắn.
// Viết thành câu tự nhiên: Whisper bắt chước văn phong của prompt, danh sách rời rạc làm nó ra chữ lạ.
// Tránh từ tiếng Anh ngắn dễ lẫn với từ tiếng Việt (bug, log): Whisper hay ghép chúng vào câu
// thay cho từ thật ("có bị impact không" thành "có bị bug không").
const PROMPT_VI =
  'Mình đang sửa UI: thêm button, label, input, form, modal, dropdown, table, column, layout, component, page. ' +
  'Gọi API, đọc JSON, viết CSS, dùng React hook và TypeScript. ' +
  'Xong thì git commit, push, tạo pull request, chạy unit test, build rồi deploy. ' +
  'Việc này có impact gì không, có cần refactor function không, hỏi Copilot hoặc Claude.';
// Tiếng Anh: cùng mục đích, để Whisper viết đúng chữ viết tắt (UI, API, JSON) và tên tool thay vì đoán từ khác.
const PROMPT_EN =
  "I'm fixing the UI: adding a button, label, input, form, modal, dropdown, table, column, layout, component, page. " +
  'Calling the API, reading JSON, writing CSS, using React hooks and TypeScript. ' +
  'Then git commit, push, open a pull request, run the unit tests, build and deploy. ' +
  'Does this have any impact, should we refactor the function, ask Copilot or Claude.';

/**
 * Prompt cho Whisper: thuật ngữ mặc định rồi từ điển của người dùng.
 * Cố ý không đưa chữ đã nhận vào: Whisper hay chép prompt vào kết quả, và khi người dùng
 * xoá đi nói lại đúng câu đó thì bộ lọc echo sẽ xoá mất câu thật. Nối ý đã có LLM lo.
 */
export function buildPrompt(glossary: string[] = [], lang: Lang = 'vi'): string {
  const terms = glossary.map((t) => t.trim()).filter(Boolean);
  const base = lang === 'en' ? PROMPT_EN : PROMPT_VI;
  if (!terms.length) return base;
  return lang === 'en' ? `${base} This project has ${terms.join(', ')}.` : `${base} Project này có ${terms.join(', ')}.`;
}

export function postProcess(text: string): string {
  return text.trim().replace(/\.$/u, '');
}

export async function transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const form = new FormData();
  form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', MODEL);
  // 'auto' và rỗng đều để Whisper tự nhận diện; câu mồi thì theo promptLang (ngôn ngữ nghe được gần nhất) nếu có.
  const language = opts.language === undefined ? 'vi' : isAuto(opts.language) ? '' : opts.language.trim();
  if (language) form.append('language', language);
  form.append('response_format', 'verbose_json');
  const prompt = buildPrompt(opts.glossary, opts.promptLang ?? langOf(language));
  form.append('prompt', prompt);

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
  if (data.language) opts.onLanguage?.(data.language);
  const raw = stripHallucinations(joinConfidentSegments(data));
  // Lúc im lặng Whisper có thể chép nguyên câu prompt ra; bỏ phần đó.
  return postProcess(stripContextEcho(raw, prompt));
}

interface GroqSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}
interface GroqVerbose {
  text?: string;
  language?: string;
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
  // Tiếng Anh: Whisper bịa đúng những câu này khi mic chỉ thu tiếng gõ phím hay quạt (log hands-free 2026-09-23: ba lần
  // "Thank you." lọt qua và bị tự gửi). Cả câu phải là câu bịa; "thank you, now refactor" vẫn được giữ.
  /^(thank you|thanks|thank you very much|thank you so much)( for (watching|listening))?( and (see you|bye).*)?$/u,
  /^thanks for (watching|listening)( and .*)?$/u,
  /^(please )?(like and )?subscribe.*$/u,
  /^(bye|goodbye|see you( next time| soon)?)$/u,
  /^you$/u,
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

/** Cụm ngắn tối đa chừng này từ mới bị coi là lặp; câu dài mà lặp thì gần như chắc là người dùng cố ý nói lại. */
const REPEAT_MAX_WORDS = 4;

/**
 * Cụm mới chỉ lặp lại đúng đuôi của chữ đã gõ (hands-free): tiếng ồn làm Whisper bịa cùng một câu ngắn cho mỗi cụm,
 * mỗi câu qua được bộ lọc riêng lẻ nhưng cộng dồn thành đủ từ để tự gửi. So theo từ đã chuẩn hoá, bỏ dấu câu.
 */
export function repeatsTail(context: string, piece: string): boolean {
  const next = words(piece).map(normalizeWord).filter(Boolean);
  if (!next.length || next.length > REPEAT_MAX_WORDS) return false;
  const prev = words(context).map(normalizeWord).filter(Boolean);
  if (prev.length < next.length) return false;
  const tail = prev.slice(prev.length - next.length);
  return tail.every((w, i) => w === next[i]);
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whisper hay chép lại đoạn cuối của prompt vào kết quả.
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
