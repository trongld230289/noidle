import type { Target } from './injector';

export interface RefineOptions {
  apiKey: string;
  target: Target;
  /** Chữ đã nhận ở các cụm trước, để chấm câu và nối ý cho đúng. */
  context?: string;
  model?: string;
  /** Thuật ngữ riêng của người dùng: tên project, tên biến, tên người. */
  glossary?: string[];
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Lỗi gọi Groq: hàm vẫn trả chữ thô, nhưng báo ở đây để extension ghi log hoặc cảnh báo (model bị gỡ, hết hạn mức...). */
  onError?: (message: string) => void;
  /** Đồng hồ, để test điều khiển thời gian tạm dừng sau 429. */
  now?: () => number;
}

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
/**
 * Groq gỡ llama-3.3-70b-versatile và llama-3.1-8b-instant khỏi gói miễn phí ngày 16/8/2026 (trả 404).
 * gpt-oss-120b là model Groq khuyên thay; reasoning_effort low để nhanh (~1,3s) mà vẫn sửa đúng.
 */
export const DEFAULT_REFINE_MODEL = 'openai/gpt-oss-120b';
const REASONING_EFFORT = 'low';
const DROP = '[BỎ]';
const MAX_CONTEXT_CHARS = 300;

const SYSTEM = `Bạn sửa chính tả cho chữ nhận dạng giọng nói tiếng Việt của lập trình viên. Đầu vào là một mẩu câu đang nói, có thể cụt, mẩu sau sẽ đến tiếp.
Chỉ làm: sửa dấu thanh sai; thêm dấu phẩy hoặc dấu hỏi khi rõ ràng cần; viết hoa đầu câu; viết hoa chữ viết tắt tiếng Anh quen thuộc nếu từ đó không có dấu (ui thành UI, api thành API).
Không bao giờ thêm dấu chấm ở cuối đoạn, vì mẩu sau sẽ nối tiếp.
Không: thêm, bỏ, đổi thứ tự hay thay từ, kể cả từ gần nghĩa (nha giữ là nha, không đổi thành nhé); hoàn thiện câu cụt; dịch (tiếng Anh giữ tiếng Anh, tiếng Việt giữ tiếng Việt); đổi từ có dấu thành viết tắt ("bị" không thành "BI"); trả lời, giải thích hay bọc trong ngoặc kép.
Đoạn hoàn toàn vô nghĩa thì trả về đúng ${DROP}; mẩu ngắn hay cụt vẫn là câu bình thường, trả nguyên.
Chỉ trả về văn bản đã sửa.`;

const TARGET_HINT: Record<Target, string> = {
  terminal: 'Chữ sẽ gõ vào terminal (lệnh shell hoặc mô tả việc cần làm), giữ nguyên cú pháp lệnh.',
  editor: 'Chữ sẽ chèn vào file mã nguồn hoặc tài liệu.',
  chat: 'Chữ là câu hỏi hoặc yêu cầu gửi cho AI assistant.',
  clipboard: 'Chữ sẽ dán vào ứng dụng khác.',
};

/** Làm sạch câu trả lời của LLM; trả về input nếu câu trả lời trông không đáng tin. */
export function cleanReply(reply: string, input: string): string {
  let out = reply.trim();
  if (out === DROP) return '';
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1).trim();
  }
  if (!out) return input;
  if (out.length > input.length * 2 + 40) return input;
  if (!keepsMostWords(input, out)) return input;
  return out;
}

// So sánh không dấu để "sua ham" và "sửa hàm" tính là cùng từ.
const norm = (w: string) =>
  w
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * LLM chỉ được sửa, không được viết lại. Nếu quá nửa số từ của input biến mất khỏi output
 * (ví dụ "impact không" thành "bug"), coi như LLM bịa và giữ input.
 * Cho phép chênh vì LLM hợp nhất phiên âm ("du ai" thành "UI") và thêm dấu.
 */
export function keepsMostWords(input: string, output: string): boolean {
  const inWords = input.split(/\s+/u).map(norm).filter(Boolean);
  if (inWords.length === 0) return true;
  const outSet = new Set(output.split(/\s+/u).map(norm).filter(Boolean));
  const kept = inWords.filter((w) => outSet.has(w)).length;
  const outCount = outSet.size;
  if (outCount > inWords.length + 2) return false; // thêm từ = hoàn thiện câu
  return kept / inWords.length >= 0.5;
}

/**
 * Hết hạn mức Groq (429) thì tạm tắt bước sửa câu cho các cụm còn lại của lượt nói này: chèn thẳng chữ thô,
 * không gọi mạng (mỗi lần gọi để nhận 429 tốn ~300ms và một dòng log). Lượt nói mới (F6, hands-free mở mic lại)
 * gọi resetRefinePause() để thử lại ngay, vì hạn mức có thể đã được nới (nạp tiền, đổi model). Trong cùng lượt,
 * quá giờ reset Groq báo (x-ratelimit-reset-tokens dạng "2m59.56s" hoặc retry-after giây) thì cũng tự thử lại.
 */
let pausedUntil = 0;
const MAX_PAUSE_SECONDS = 24 * 3600;

/** Gọi khi bắt đầu một lượt nói mới: bỏ trạng thái tạm tắt để thử Groq lại ngay. */
export function resetRefinePause(): void {
  pausedUntil = 0;
}

export function parseResetSeconds(headers: Record<string, string> | Headers): number {
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : headers[k]) ?? '';
  const retryAfter = Number(get('retry-after'));
  if (retryAfter > 0) return retryAfter;
  for (const key of ['x-ratelimit-reset-tokens', 'x-ratelimit-reset-requests']) {
    const v = get(key).trim();
    if (!v) continue;
    let total = 0;
    let matched = false;
    for (const m of v.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g)) {
      matched = true;
      const n = Number(m[1]);
      total += m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : m[2] === 's' ? n : n / 1000;
    }
    if (matched && total > 0) return total;
  }
  return 60;
}

function describeSeconds(s: number): string {
  if (s >= 3600) return `${Math.round(s / 360) / 10} giờ`;
  if (s >= 60) return `${Math.round(s / 60)} phút`;
  return `${Math.round(s)} giây`;
}

/** Sửa chính tả và dấu câu bằng LLM trên Groq. Lỗi gì cũng trả về text gốc. */
export async function refine(text: string, opts: RefineOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  if (now() < pausedUntil) return text;
  const fetchFn = opts.fetchFn ?? fetch;
  const context = (opts.context ?? '').trim().slice(-MAX_CONTEXT_CHARS);
  const terms = (opts.glossary ?? []).map((t) => t.trim()).filter(Boolean);
  const user =
    `${TARGET_HINT[opts.target]}\n` +
    (terms.length ? `Thuật ngữ người dùng hay nói, giữ đúng chính tả: ${terms.join(', ')}\n` : '') +
    (context
      ? `Chữ ngay trước đó, chỉ để nối câu, không đưa vào kết quả (trùng thì là người nói nhắc lại, vẫn sửa bình thường): ${context}\n`
      : '') +
    `Đoạn cần sửa:\n${text}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetchFn(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_REFINE_MODEL,
        temperature: 0,
        max_tokens: 512,
        reasoning_effort: REASONING_EFFORT,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const model = opts.model ?? DEFAULT_REFINE_MODEL;
      if (res.status === 429) {
        const seconds = Math.min(parseResetSeconds(res.headers), MAX_PAUSE_SECONDS);
        pausedUntil = now() + seconds * 1000;
        opts.onError?.(
          `Groq hết hạn mức model ${model} (HTTP 429): tắt sửa câu cho hết lượt nói này, chèn thẳng chữ thô của Whisper (Groq báo reset sau ${describeSeconds(seconds)})`,
        );
        return text;
      }
      opts.onError?.(
        res.status === 404
          ? `model ${model} không tồn tại trên Groq (HTTP 404), đổi viVoice.refineModel; đang dùng chữ thô của Whisper`
          : `Groq trả HTTP ${res.status} cho model ${model}, đang dùng chữ thô của Whisper`,
      );
      return text;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return cleanReply(data.choices?.[0]?.message?.content ?? '', text);
  } catch (err) {
    opts.onError?.(`không gọi được Groq để sửa câu: ${(err as Error).message}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
