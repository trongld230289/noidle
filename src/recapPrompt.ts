import { SPEAK_MARK } from './speech';
import { type Lang } from './lang';

/**
 * Hướng dẫn recap cho Claude, người dùng tự sửa qua setting noIdle.recapPrompt.
 *
 * Người dùng chỉ thấy và sửa phần thân: nói gì trong recap, dài bao nhiêu, kiêng gì. Câu hợp đồng
 * (kết thúc bằng phần bắt đầu bằng 🔊 ở đầu dòng, từ đó đến hết được đọc) và câu ngôn ngữ do hook tự nối,
 * người dùng không xoá được nên recap lúc nào cũng có loa và đúng thứ tiếng của lượt.
 *
 * Người dùng viết một thứ tiếng; extension dịch sang thứ tiếng còn lại bằng Copilot hay Claude họ đang dùng
 * (không cần API key), lưu cache, ghi cả hai bản vào hook-config. Chưa dịch xong thì hook dùng nguyên văn
 * cộng câu ngôn ngữ của lượt: Claude đọc tiếng Việt vẫn hiểu, và vẫn viết đúng thứ tiếng.
 *
 * Không import vscode để hook (tiến trình riêng) cũng bundle được.
 */

export const DEFAULT_RECAP_PROMPT: Record<Lang, string> = {
  // Nhiều dòng để ô setting (multilineText) dễ đọc; hook gửi nguyên các dòng này cho Claude.
  vi: [
    'Recap cuối câu trả lời, người dùng chỉ nghe, không nhìn màn hình.',
    '- Độ dài: hỏi thông tin thì 3 đến 8 câu; báo việc vừa làm thì 2 đến 3 câu.',
    '- Câu đầu dưới 12 từ, nói kết luận trước.',
    '- Sau đó: các ý chính, số liệu quan trọng, điều cần người dùng làm.',
    '- Văn nói; không code, đường dẫn, tên file, bảng hay markdown.',
  ].join('\n'),
  en: [
    'Recap at the end of the answer; the user only listens and does not look at the screen.',
    '- Length: 3 to 8 sentences for information questions; 2 to 3 sentences when reporting what you did.',
    '- First sentence under 12 words, conclusion first.',
    '- Then: the main points, important numbers, what the user needs to do.',
    '- Spoken style; no code, paths, file names, tables or markdown.',
  ].join('\n'),
};

/** Câu hợp đồng, hook nối trước phần thân: định nghĩa "phần đọc" và cách hook cắt text. */
const CONTRACT: Record<Lang, string> = {
  vi: `Kết thúc mỗi câu trả lời bằng một phần riêng bắt đầu bằng ${SPEAK_MARK} ở đầu dòng; mọi thứ từ đó đến hết câu trả lời sẽ được đọc thành tiếng.`,
  en: `End every answer with a separate section that starts with ${SPEAK_MARK} at the beginning of a line; everything from there to the end of the answer is read aloud.`,
};

/** Câu ngôn ngữ, nối cuối: phần thân có thể đang là thứ tiếng khác (chưa dịch) nên vẫn phải nói rõ. */
const LANGUAGE_LINE: Record<Lang, string> = {
  vi: 'Viết phần đó bằng tiếng Việt.',
  en: 'Write that section in English.',
};

/**
 * Quy tắc số, hook tự nối như câu hợp đồng, người dùng không phải nhớ khi tự viết prompt: giọng đọc phát âm
 * chữ số tự nhiên ("1.0.22" nghe rõ hơn "một chấm không chấm hai mươi hai" và đỡ tốn chữ).
 */
const NUMBERS_LINE: Record<Lang, string> = {
  vi: 'Số viết bằng chữ số như 4200 hay 1.9.0, đừng đánh vần.',
  en: 'Write numbers as digits, like 4200 or 1.9.0; do not spell them out.',
};

export interface RecapPrompts {
  vi?: string;
  en?: string;
}

const other = (lang: Lang): Lang => (lang === 'vi' ? 'en' : 'vi');

/** Hướng dẫn chèn vào prompt: hợp đồng + thân (bản đúng ngôn ngữ, chưa dịch thì bản gốc, không có thì mặc định) + quy tắc số và câu ngôn ngữ. */
export function recapInstruction(prompts: RecapPrompts | undefined, lang: Lang): string {
  const body = prompts?.[lang] ?? prompts?.[other(lang)] ?? DEFAULT_RECAP_PROMPT[lang];
  return `${CONTRACT[lang]}\n${body.trim()}\n${NUMBERS_LINE[lang]} ${LANGUAGE_LINE[lang]}`;
}

const VIET_LETTERS = /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/iu;

/** Ngôn ngữ người dùng viết prompt: có chữ có dấu ở bất kỳ đâu là tiếng Việt, còn lại tiếng Anh. */
export function recapSourceLang(text: string): Lang {
  return VIET_LETTERS.test(text) ? 'vi' : 'en';
}

const normalize = (text: string): string => text.trim();

/** Rỗng hay đúng bản mặc định thì có sẵn cả hai thứ tiếng, không phải dịch. */
export function needsTranslation(text: string): boolean {
  const t = normalize(text);
  return t !== '' && t !== DEFAULT_RECAP_PROMPT.vi && t !== DEFAULT_RECAP_PROMPT.en;
}

/** Hai bản để ghi vào hook-config: bản gốc ở ngôn ngữ nguồn, bản dịch (nếu đã có) ở ngôn ngữ kia. */
export function recapPromptsFor(text: string, translated?: string): RecapPrompts {
  if (!needsTranslation(text)) return { ...DEFAULT_RECAP_PROMPT };
  const source = normalize(text);
  const from = recapSourceLang(source);
  const prompts: RecapPrompts = { [from]: source };
  if (translated?.trim()) prompts[other(from)] = translated.trim();
  return prompts;
}

export interface TranslationRequest {
  from: Lang;
  to: Lang;
  /** Prompt gửi cho model dịch. */
  prompt: string;
}

/** Prompt dịch nguyên văn sang thứ tiếng còn lại, chỉ trả về bản dịch. */
export function translationRequest(text: string): TranslationRequest {
  const from = recapSourceLang(text);
  const to = other(from);
  const prompt =
    to === 'en'
      ? `Translate the following instructions verbatim into English. Keep the ${SPEAK_MARK} symbol, numbers, example names, line breaks and "- " bullets unchanged. Reply with the translation only, no explanation or quotes.\n\n${text.trim()}`
      : `Dịch nguyên văn hướng dẫn sau sang tiếng Việt. Giữ nguyên ký hiệu ${SPEAK_MARK}, các con số, tên ví dụ, chỗ xuống dòng và gạch đầu dòng "- ". Chỉ trả về bản dịch, không giải thích, không bọc trong ngoặc kép.\n\n${text.trim()}`;
  return { from, to, prompt };
}

/** Model hay bọc câu trả lời trong ``` hoặc ngoặc kép: bóc ra. */
export function cleanTranslation(raw: string): string {
  let t = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')))) t = t.slice(1, -1).trim();
  return t;
}

export interface RecapTranslator {
  /** Tên ghi log: copilot, claude. */
  name: string;
  /** Trả về câu trả lời thô của model, hoặc undefined khi không dùng được (không có model, không có binary...). */
  run: (prompt: string) => Promise<string | undefined>;
}

/** Thử từng backend theo thứ tự; backend lỗi hay trả rỗng thì sang backend sau. Tất cả hỏng thì undefined. */
export async function translateRecap(
  text: string,
  translators: RecapTranslator[],
): Promise<{ text: string; via: string } | undefined> {
  const req = translationRequest(text);
  for (const t of translators) {
    try {
      const raw = await t.run(req.prompt);
      const cleaned = raw ? cleanTranslation(raw) : '';
      if (cleaned) return { text: cleaned, via: t.name };
    } catch {
      /* backend này không dùng được, thử backend sau */
    }
  }
  return undefined;
}
