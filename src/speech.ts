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
  // Từ dòng 🔊 đầu tiên đến hết là phần Claude viết để đọc (có thể nhiều dòng, có danh sách).
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(SPEAK_MARK));
  if (start >= 0) {
    const block = lines.slice(start).join('\n').split(SPEAK_MARK).join(' ');
    const spoken = stripMarkdown(block);
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

/** Hướng dẫn chèn vào mỗi prompt để Claude kết thúc bằng phần đọc được. */
export const PROMPT_CONTEXT =
  `Người dùng đang nghe câu trả lời bằng giọng nói qua tai nghe và thường không nhìn màn hình. ` +
  `Kết thúc mỗi câu trả lời bằng một phần riêng bắt đầu bằng ${SPEAK_MARK} ở đầu dòng; mọi thứ từ đó đến hết câu trả lời sẽ được đọc thành tiếng. ` +
  `Phần này phải đủ nghĩa để người nghe hiểu trọn câu trả lời mà không cần đọc phần trên: ` +
  `nói kết luận, các ý chính, số liệu quan trọng, và điều gì đang cần ở người dùng. ` +
  `Nếu người dùng hỏi thông tin (liệt kê, số liệu, giải thích, so sánh) thì kể đủ các mục chính bằng lời nói, kiểu "gồm a, b và c", thường ba đến tám câu. ` +
  `Nếu chỉ là báo cáo việc bạn vừa làm thì hai đến ba câu: đã làm gì, kết quả ra sao, còn cần gì. ` +
  `Câu đầu tiên của phần này thật ngắn, dưới mười hai từ, nêu ngay kết luận, vì nó được đọc lên trước tiên. ` +
  `Viết bằng tiếng Việt, giọng nói chuyện tự nhiên như đang kể cho đồng nghiệp nghe. ` +
  `Không chứa code, đường dẫn, tên file, bảng, gạch đầu dòng hay ký hiệu markdown; số liệu ngắn thì đọc bằng chữ, ví dụ "ba mươi chín quyền".`;

/**
 * Tách thành khối để phát dần. Edge tổng hợp gần bằng tốc độ đọc thật và chỉ gửi khi xong cả yêu cầu,
 * nên khối đầu phải thật ngắn (một mệnh đề, tối đa ~firstMax ký tự) để nghe được sau vài giây;
 * các khối sau ~2 câu hoặc ~maxChars ký tự vì gọi quá nhiều yêu cầu dồn dập thì Edge chặn tạm.
 */
export function splitSentences(text: string, maxChars = 220, firstMax = 90): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];

  // Khối đầu: câu đầu, nếu dài thì cắt ở dấu phẩy/chấm phẩy gần nhất trước firstMax.
  let first = sentences[0];
  let rest = sentences.slice(1);
  if (first.length > firstMax) {
    const head = first.slice(0, firstMax);
    const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (cut > 20) {
      rest = [first.slice(cut + 1).trim(), ...rest];
      first = first.slice(0, cut + 1).trim();
    }
  }

  const out: string[] = [first];
  let cur = '';
  let count = 0;
  for (const s of rest) {
    if (cur && (count >= 2 || cur.length + 1 + s.length > maxChars)) {
      out.push(cur);
      cur = '';
      count = 0;
    }
    cur = cur ? `${cur} ${s}` : s;
    count++;
  }
  if (cur) out.push(cur);
  return out;
}

export interface HookInput {
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    questions?: { question?: string; header?: string; options?: { label?: string }[] }[];
    question?: string;
    options?: (string | { label?: string })[];
    [k: string]: unknown;
  };
}

/** Tên workspace để đọc: thư mục cuối của cwd, bỏ dấu gạch cho dễ nghe. */
export function workspaceName(cwd?: string): string {
  const base = (cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[-_.]+/g, ' ').trim() || 'không tên';
}

/**
 * Câu ngắn để đọc khi Claude Code cần người dùng. Cố ý đơn giản: chỉ tên workspace và việc cần làm,
 * vì người nghe đang làm nhiều cửa sổ, chỉ cần biết quay về đâu. Trả về '' nếu sự kiện không cần báo.
 */
export function announcement(input: HookInput): string {
  const ws = workspaceName(input.cwd);
  const event = input.hook_event_name ?? '';
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') return `Workspace ${ws} cần bạn xác nhận câu trả lời.`;
  // Tool đặt câu hỏi cũng đi qua bước xin quyền; PreToolUse đã báo rồi nên không báo lần hai.
  if (event === 'PermissionRequest') return input.tool_name === 'AskUserQuestion' ? '' : `Workspace ${ws} cần approve.`;
  if (event === 'Notification') {
    const type = input.notification_type ?? '';
    if (type === 'permission_prompt') return `Workspace ${ws} cần approve.`;
    if (type === 'elicitation_dialog') return `Workspace ${ws} cần bạn xác nhận câu trả lời.`;
  }
  return '';
}
