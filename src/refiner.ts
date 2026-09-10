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
}

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_REFINE_MODEL = 'llama-3.3-70b-versatile';
const DROP = '[BỎ]';
const MAX_CONTEXT_CHARS = 300;

const SYSTEM = `Bạn là bộ sửa lỗi chính tả cho văn bản nhận dạng giọng nói tiếng Việt của một lập trình viên.
Việc duy nhất: thêm hoặc sửa dấu thanh bị sai, thêm dấu phẩy và dấu chấm hỏi nếu rõ ràng cần, viết hoa đầu câu. Ngoài ra giữ nguyên tất cả.
Đoạn đưa vào là một mẩu của câu đang nói, thường bị cắt giữa chừng và mẩu tiếp theo sẽ đến sau.
Cấm:
- Cấm thêm từ, bỏ từ, đổi thứ tự từ, hay thay một từ bằng từ khác, kể cả khi bạn thấy từ khác hợp hơn.
- Cấm hoàn thiện câu cụt. Cấm thêm dấu chấm ở cuối nếu câu chưa kết thúc rõ ràng.
- Cấm dịch. Từ tiếng Anh giữ nguyên tiếng Anh, từ tiếng Việt giữ nguyên tiếng Việt.
- Cấm đổi một từ tiếng Việt có dấu thành chữ viết tắt. "bị" vẫn là "bị", không phải "BI".
- Cấm trả lời, giải thích, hay bọc kết quả trong dấu ngoặc kép.
Được phép:
- Viết hoa chữ viết tắt tiếng Anh quen thuộc khi từ đưa vào không có dấu tiếng Việt, ví dụ "ui" thành "UI", "api" thành "API".
- Nếu toàn bộ đoạn là chuỗi âm lộn xộn không thể hiểu, trả về đúng chuỗi ${DROP}. Mẩu ngắn hay cụt vẫn là câu nói bình thường, phải trả về nguyên.
Chỉ trả về văn bản đã sửa.`;

const TARGET_HINT: Record<Target, string> = {
  terminal: 'Văn bản sẽ được gõ vào terminal, có thể là lệnh shell hoặc mô tả việc cần làm. Giữ nguyên cú pháp lệnh.',
  editor: 'Văn bản sẽ được chèn vào file mã nguồn hoặc tài liệu.',
  chat: 'Văn bản là câu hỏi hoặc yêu cầu gửi cho AI assistant trong VS Code.',
  clipboard: 'Văn bản sẽ được dán vào một ứng dụng khác.',
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

/** Sửa chính tả và dấu câu bằng LLM trên Groq. Lỗi gì cũng trả về text gốc. */
export async function refine(text: string, opts: RefineOptions): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const context = (opts.context ?? '').trim().slice(-MAX_CONTEXT_CHARS);
  const terms = (opts.glossary ?? []).map((t) => t.trim()).filter(Boolean);
  const user =
    `${TARGET_HINT[opts.target]}\n` +
    (terms.length ? `Thuật ngữ người dùng hay nói, giữ đúng chính tả: ${terms.join(', ')}\n` : '') +
    (context
      ? `Chữ đã nhận trước đó, chỉ để tham khảo cách nối câu, không đưa vào kết quả. Nếu đoạn cần sửa trùng với chữ này thì người nói đang nhắc lại, vẫn sửa và trả về bình thường: ${context}\n`
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
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return text;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return cleanReply(data.choices?.[0]?.message?.content ?? '', text);
  } catch {
    return text;
  } finally {
    clearTimeout(timer);
  }
}
