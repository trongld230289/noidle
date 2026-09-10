/** Các hàm thuần cho phần đọc câu trả lời của Claude Code thành tiếng. */

export const SPEAK_MARK = '🔊';
const MAX_FALLBACK_CHARS = 320;

/** Lấy text của lượt trả lời cuối cùng của assistant trong transcript JSONL của Claude Code. */
export function lastAssistantText(jsonl: string): string {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content : joinTextBlocks(content);
    if (text.trim()) return text;
  }
  return '';
}

function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Chọn phần sẽ đọc: ưu tiên các dòng bắt đầu bằng 🔊 (Claude được dặn tóm tắt ở đó);
 * không có thì đọc phần văn xuôi đầu tiên, bỏ code và markdown, cắt ở ranh giới câu.
 */
export function pickSpeech(text: string): string {
  const marked = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(SPEAK_MARK))
    .map((l) => l.slice(SPEAK_MARK.length).trim())
    .filter(Boolean);
  if (marked.length) return marked.join(' ');

  const prose = stripMarkdown(text);
  if (prose.length <= MAX_FALLBACK_CHARS) return prose;
  const cut = prose.slice(0, MAX_FALLBACK_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > MAX_FALLBACK_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim();
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, '$1$2')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** Hướng dẫn chèn vào mỗi prompt để Claude kết thúc bằng dòng tóm tắt đọc được. */
export const PROMPT_CONTEXT =
  `Người dùng đang nghe câu trả lời bằng giọng nói qua tai nghe. ` +
  `Kết thúc mỗi câu trả lời bằng một dòng riêng bắt đầu bằng ${SPEAK_MARK}, ` +
  `tóm tắt kết quả trong một đến hai câu ngắn bằng tiếng Việt, giọng nói chuyện tự nhiên, ` +
  `nói rõ đã xong hay còn cần gì ở người dùng. Dòng này không chứa code, đường dẫn, tên file hay ký hiệu markdown.`;
