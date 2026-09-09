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
  form.append('response_format', 'json');
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

  const data = (await res.json()) as { text?: string };
  return postProcess(data.text ?? '');
}
