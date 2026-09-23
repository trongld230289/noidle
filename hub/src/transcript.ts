/** Đọc transcript JSONL của Claude Code và chọn phần đáng hiện/đọc. Viết riêng cho hub, không dùng code extension. */

export const SPEAK_MARK = '🔊';
const MAX_FALLBACK_CHARS = 320;

/** Text của lượt assistant cuối có chữ (bỏ entry chỉ có tool_use). Hiểu content là chuỗi hoặc mảng block. */
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
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Từ dòng 🔊 đầu tiên đến hết; không có thì văn xuôi đầu, bỏ code và markdown, cắt ở ranh giới câu. */
export function pickSpeech(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(SPEAK_MARK));
  if (start >= 0) {
    const spoken = stripMarkdown(lines.slice(start).join('\n').split(SPEAK_MARK).join(' '));
    if (spoken) return spoken;
  }
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

/** Thư mục cuối của cwd, bỏ dấu gạch cho dễ đọc. */
export function workspaceName(cwd: string): string {
  const base = (cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[-_.]+/g, ' ').trim() || 'unnamed';
}
