/**
 * Ngôn ngữ làm việc của extension, lấy từ setting noIdle.language.
 * Một công tắc chi phối tất cả: Whisper, LLM sửa câu, hướng dẫn 🔊 cho Claude, câu hook nói ra,
 * giọng đọc mặc định và bảng phiên âm. Giá trị "auto": mic để Whisper tự nhận diện, còn hook đoán theo
 * prompt vừa gửi và nhớ theo phiên. Không dùng vscode để hook (tiến trình riêng) cũng import được.
 */
export type Lang = 'vi' | 'en';

/** 'en', 'en-XX' hay 'english' là tiếng Anh; mọi giá trị khác (rỗng, auto, vietnamese...) coi là tiếng Việt. */
export function langOf(setting: string | undefined): Lang {
  return /^en(glish)?\b/i.test((setting ?? '').trim()) ? 'en' : 'vi';
}

export function isAuto(setting: string | undefined): boolean {
  return /^auto$/i.test((setting ?? '').trim());
}

const VIET_LETTERS = /[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/iu;
// Từ tiếng Việt hay gõ không dấu, hiếm khi xuất hiện nguyên từ trong câu tiếng Anh ("ban", "la", "di" bị bỏ vì trùng).
const VIET_WORDS = /(^|\s)(khong|duoc|dc|minh|nha|nhe|roi|xong|sua|lam|giup|cai|nay|toi|cua|voi|hoi|cho minh|di nha|ko|dang|chay|kiem tra|gio)(\s|$)/i;
const MIN_WORDS_FOR_ENGLISH = 3;

/**
 * Đoán ngôn ngữ của một prompt: có chữ có dấu hoặc từ tiếng Việt quen thuộc thì tiếng Việt;
 * câu ASCII từ ba từ trở lên thì tiếng Anh; ngắn quá ("ok", "git push") thì không đoán, để người gọi giữ ngôn ngữ cũ.
 */
export function detectLang(text: string): Lang | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (VIET_LETTERS.test(t) || VIET_WORDS.test(t)) return 'vi';
  const words = t.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length >= MIN_WORDS_FOR_ENGLISH && /^[\x00-\x7F]*$/.test(t)) return 'en';
  return undefined;
}

/**
 * Giọng dùng khi tiếng Anh mà người dùng còn để giọng vi-VN: giọng đó đọc tiếng Anh theo âm Việt, không nghe được.
 * Ava (nữ, đa ngôn ngữ) được chọn sau khi nghe thử 11 giọng Edge ngày 22/9/2026.
 */
export const ENGLISH_FALLBACK_VOICE = 'en-US-AvaMultilingualNeural';

/** Giọng mặc định khi cài: Brian đa ngôn ngữ, đọc được cả Việt lẫn Anh trong một câu. Phải khớp default của noIdle.voice trong package.json. */
export const DEFAULT_VOICE = 'en-US-BrianMultilingualNeural';

export function effectiveVoice(voice: string, lang: Lang): string {
  return lang === 'en' && /^vi-/i.test(voice) ? ENGLISH_FALLBACK_VOICE : voice;
}

/**
 * Bảng phát âm mặc định (pronounce.ts) phiên âm thuật ngữ Anh sang âm Việt cho giọng vi-VN. Giọng đa ngôn ngữ
 * như Brian tự đọc "API", "README.md" đúng tiếng Anh, phiên âm ra lại làm nó đọc sai. Chỉ dùng bảng khi câu
 * tiếng Việt và giọng thực tế là vi-VN; bảng riêng của người dùng thì luôn áp dụng.
 */
export function usesVietPronunciation(voice: string, lang: Lang): boolean {
  return lang === 'vi' && /^vi-/i.test(effectiveVoice(voice, lang));
}
