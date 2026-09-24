/** Các hàm thuần cho phần đọc câu trả lời của Claude Code thành tiếng. */

import type { Lang } from './lang';

export const SPEAK_MARK = '🔊';
const MAX_FALLBACK_CHARS = 320;

/**
 * Lấy text của lượt trả lời cuối cùng của assistant trong transcript JSONL.
 * Hiểu hai định dạng: Claude Code (`type: "assistant"`, `message.content` là chuỗi hoặc mảng block)
 * và Copilot Chat trong VS Code (`type: "assistant.message"`, `data.content` là chuỗi).
 */
export function lastAssistantText(jsonl: string): string {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: unknown }; data?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    let content: unknown;
    if (entry.type === 'assistant') content = entry.message?.content;
    else if (entry.type === 'assistant.message') content = entry.data?.content;
    else continue;
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

/** Claude có chủ ý viết phần 🔊 (một dòng bắt đầu bằng 🔊) hay không. */
export function hasSpeakSection(text: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trim().startsWith(SPEAK_MARK));
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

const SPEECH_WORDS_VI =
  `Chỉ trong phần ${SPEAK_MARK}, dựa vào ngữ nghĩa để tách tên ghép tiếng Anh thành các từ dễ đọc khi hiểu rõ: ` +
  `SuperAdmin thành Super Admin; ShipNGo có thể thành Ship N Go nếu đúng tên đang nói. ` +
  `Giữ nguyên Shippo và tên không chắc cách tách; không tách máy móc theo chữ hoa, không tự bịa phiên âm hay đổi nghĩa. ` +
  `Giữ từ tiếng Anh gốc, không phiên âm sang tiếng Việt. Phần trả lời chính giữ nguyên tên gốc.`;

const SPEECH_WORDS_EN =
  `Only in the ${SPEAK_MARK} section, use meaning to separate compound English names into readable words when confident: ` +
  `SuperAdmin becomes Super Admin; ShipNGo may become Ship N Go if that matches the intended name. ` +
  `Keep Shippo and names with uncertain word boundaries unchanged; do not split mechanically by capitalization, invent pronunciations or change meaning. ` +
  `Keep the original English words, without Vietnamese phonetic respelling. Preserve original names in the main answer.`;

/** Hướng dẫn chèn vào mỗi prompt để Claude kết thúc bằng phần đọc được. */
const PROMPT_CONTEXT_VI =
  `Người dùng đang nghe câu trả lời bằng giọng nói qua tai nghe và thường không nhìn màn hình. ` +
  `Kết thúc mỗi câu trả lời bằng một phần riêng bắt đầu bằng ${SPEAK_MARK} ở đầu dòng; mọi thứ từ đó đến hết câu trả lời sẽ được đọc thành tiếng. ` +
  `Phần này phải đủ nghĩa để người nghe hiểu trọn câu trả lời mà không cần đọc phần trên: ` +
  `nói kết luận, các ý chính, số liệu quan trọng, và điều gì đang cần ở người dùng. ` +
  `Nếu người dùng hỏi thông tin (liệt kê, số liệu, giải thích, so sánh) thì kể đủ các mục chính bằng lời nói, kiểu "gồm a, b và c", thường ba đến tám câu. ` +
  `Nếu chỉ là báo cáo việc bạn vừa làm thì hai đến ba câu: đã làm gì, kết quả ra sao, còn cần gì. ` +
  `Câu đầu tiên của phần này thật ngắn, dưới mười hai từ, nêu ngay kết luận, vì nó được đọc lên trước tiên. ` +
  `Viết bằng tiếng Việt, giọng nói chuyện tự nhiên như đang kể cho đồng nghiệp nghe. ` +
  `Không chứa code, đường dẫn, tên file, bảng, gạch đầu dòng hay ký hiệu markdown. Số (cổng, phiên bản, số lượng) viết bằng chữ số như 4200 hay 1.9.0, giọng đọc tự đọc được; đừng đánh vần thành chữ. ` +
  SPEECH_WORDS_VI;

/**
 * Dòng nhắc ngắn cho các prompt sau của cùng một phiên: hướng dẫn đầy đủ đã nằm trong lịch sử, chỉ cần
 * nhắc lại quy tắc cốt lõi và cách chuẩn bị tên ghép để đọc.
 */
const PROMPT_REMINDER_VI =
  `Nhắc: kết thúc bằng phần ${SPEAK_MARK} đầu dòng, tiếng Việt, đủ nghĩa khi nghe, không markdown/code. ` +
  `Chỉ tách tên ghép theo nghĩa ở phần đọc; không chắc thì giữ nguyên. Phần chính giữ tên gốc.`;

const PROMPT_CONTEXT_EN =
  `The user is listening to your answers through headphones and usually not looking at the screen. ` +
  `End every answer with a separate section that starts with ${SPEAK_MARK} at the beginning of a line; everything from there to the end of the answer is read aloud. ` +
  `That section must stand on its own so a listener understands the whole answer without reading the part above: ` +
  `state the conclusion, the main points, the important numbers, and what you need from the user. ` +
  `If the user asked for information (a list, numbers, an explanation, a comparison), say all the main items in words, like "a, b and c", usually three to eight sentences. ` +
  `If you are only reporting what you just did, two to three sentences: what you did, how it went, what you still need. ` +
  `Keep the first sentence of that section very short, under twelve words, stating the conclusion, because it is read first. ` +
  `Write in English, in a natural conversational tone, as if telling a colleague. ` +
  `No code, paths, file names, tables, bullet points or markdown symbols. Write numbers (ports, versions, counts) as digits like 4200 or 1.9.0 so the voice reads them; do not spell them out. ` +
  SPEECH_WORDS_EN;

const PROMPT_REMINDER_EN =
  `Reminder: the user is listening through headphones. End the answer with a ${SPEAK_MARK} section at the start of a line, ` +
  `in English, complete when only heard, no markdown or code. Only separate compound names by meaning in speech; ` +
  `leave uncertain names unchanged. Keep original names in the main answer.`;

export function promptContext(lang: Lang = 'vi'): string {
  return lang === 'en' ? PROMPT_CONTEXT_EN : PROMPT_CONTEXT_VI;
}

export function promptReminder(lang: Lang = 'vi'): string {
  return lang === 'en' ? PROMPT_REMINDER_EN : PROMPT_REMINDER_VI;
}

/** Các câu hook nói ra (và lý do trả về cho Claude) khi approve hoặc chọn đáp án bằng giọng, theo ngôn ngữ. */
export interface Spoken {
  dangerous: (announcement: string) => string;
  notSafe: (announcement: string) => string;
  sayApproveOrDeny: (announcement: string) => string;
  notHeardPress: string;
  unclearPress: string;
  approved: string;
  denied: string;
  approveReason: (decision: 'allow' | 'deny', heard: string) => string;
  multiSelect: string;
  chooseAfterBeep: string;
  answerAfterBeep: string;
  notHeardChoose: string;
  unclearChoose: string;
  okChoose: string;
  chosen: (labels: string[]) => string;
  answerChoice: (question: string, labels: string[]) => string;
  answerFree: (question: string, heard: string) => string;
  chooseReason: (answers: string[]) => string;
}

const SPOKEN_VI: Spoken = {
  dangerous: (a) => `${a} Lệnh này thuộc loại nguy hiểm, bạn bấm tay nhé.`,
  notSafe: (a) => `${a} Lệnh này chưa nằm trong danh sách an toàn, bạn bấm tay nhé.`,
  sayApproveOrDeny: (a) => `${a} Sau tiếng bíp, nói approve hoặc từ chối.`,
  notHeardPress: 'Mình không nghe thấy, bạn bấm tay nhé.',
  unclearPress: 'Mình không rõ, bạn bấm tay nhé.',
  approved: 'Đã approve.',
  denied: 'Đã từ chối.',
  approveReason: (d, heard) => `Người dùng ${d === 'allow' ? 'approve' : 'từ chối'} bằng giọng nói: "${heard}"`,
  multiSelect: ' Chọn được nhiều.',
  chooseAfterBeep: ' Sau tiếng bíp, nói số hoặc tên.',
  answerAfterBeep: ' Sau tiếng bíp, bạn trả lời.',
  notHeardChoose: 'Mình không nghe thấy, bạn chọn tay nhé.',
  unclearChoose: 'Mình không rõ, bạn chọn tay nhé.',
  okChoose: 'Ok, bạn chọn tay nhé.',
  chosen: (labels) => `Chọn ${labels.join(' và ')}.`,
  answerChoice: (q, labels) => `Câu hỏi "${q}": chọn ${labels.map((c) => `"${c}"`).join(' và ')}`,
  answerFree: (q, heard) => `Câu hỏi "${q}": trả lời "${heard}"`,
  chooseReason: (answers) =>
    `Người dùng đã trả lời bằng giọng nói, không cần hỏi lại. ${answers.join('. ')}. Hãy làm tiếp theo lựa chọn này.`,
};

const SPOKEN_EN: Spoken = {
  dangerous: (a) => `${a} This command is in the dangerous category, please confirm by hand.`,
  notSafe: (a) => `${a} This command is not on the safe list, please confirm by hand.`,
  sayApproveOrDeny: (a) => `${a} After the beep, say approve or deny.`,
  notHeardPress: "I didn't hear anything, please confirm by hand.",
  unclearPress: "I didn't catch that, please confirm by hand.",
  approved: 'Approved.',
  denied: 'Denied.',
  approveReason: (d, heard) => `User ${d === 'allow' ? 'approved' : 'denied'} by voice: "${heard}"`,
  multiSelect: ' You can pick several.',
  chooseAfterBeep: ' After the beep, say the number or the name.',
  answerAfterBeep: ' After the beep, say your answer.',
  notHeardChoose: "I didn't hear anything, please choose by hand.",
  unclearChoose: "I didn't catch that, please choose by hand.",
  okChoose: 'Ok, please choose by hand.',
  chosen: (labels) => `Chose ${labels.join(' and ')}.`,
  answerChoice: (q, labels) => `Question "${q}": chose ${labels.map((c) => `"${c}"`).join(' and ')}`,
  answerFree: (q, heard) => `Question "${q}": answered "${heard}"`,
  chooseReason: (answers) =>
    `The user already answered by voice, do not ask again. ${answers.join('. ')}. Continue with this choice.`,
};

export function spoken(lang: Lang = 'vi'): Spoken {
  return lang === 'en' ? SPOKEN_EN : SPOKEN_VI;
}

/**
 * Tách thành khối để phát dần. Edge chỉ gửi audio khi xong cả yêu cầu và độ trễ thất thường (nửa giây tới hơn mười giây),
 * nên khối đầu phải thật ngắn (một mệnh đề, tối đa ~firstMax ký tự) để nghe được sớm;
 * các khối sau ~2 câu hoặc ~maxChars ký tự để mỗi khối đủ dài làm đệm cho khối kế mà không gọi Edge quá dồn dập.
 */
export function splitSentences(text: string, maxChars = 220, firstMax = 90, firstMin = 40): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];

  // Khối đầu: câu đầu, nếu dài thì cắt ở dấu phẩy/chấm phẩy gần nhất trước firstMax.
  let first = sentences[0];
  let rest = sentences.slice(1);
  // Câu đầu quá ngắn ("Xong hai việc.") chỉ phát được hơn một giây, không đủ che thời gian Edge tổng hợp
  // khối hai: gộp thêm câu sau cho tới khi đủ firstMin. Câu sau dài quá thì chỉ lấy tới dấu phẩy trước firstMax.
  while (first.length < firstMin && rest.length) {
    const next = rest[0];
    if (first.length + 1 + next.length <= firstMax) {
      first = `${first} ${next}`;
      rest = rest.slice(1);
      continue;
    }
    const room = firstMax - first.length - 1;
    const head = next.slice(0, room);
    const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (cut > 20) {
      first = `${first} ${next.slice(0, cut + 1).trim()}`;
      rest = [next.slice(cut + 1).trim(), ...rest.slice(1)];
    }
    break;
  }
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
    questions?: { question?: string; header?: string; multiSelect?: boolean; options?: { label?: string }[] }[];
    question?: string;
    options?: (string | { label?: string })[];
    [k: string]: unknown;
  };
}

/** Tên workspace để đọc: thư mục cuối của cwd, bỏ dấu gạch cho dễ nghe. */
export function workspaceName(cwd?: string, lang: Lang = 'vi'): string {
  const base = (cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[-_.]+/g, ' ').trim() || (lang === 'en' ? 'unnamed' : 'không tên');
}

/**
 * Câu cứng đọc khi Claude trả lời xong ở chế độ voiceStyle 'announce': chỉ tên workspace và "xong" hay "đang hỏi bạn",
 * không đọc nội dung nên Claude không phải viết phần 🔊 (không tốn token). Câu hỏi nhận ra bằng dấu hỏi ở cuối
 * phần văn xuôi (bỏ code và markdown), vì người nghe cần biết cửa sổ đó đang chờ mình.
 */
export function doneAnnouncement(answer: string, cwd?: string, lang: Lang = 'vi'): string {
  const ws = workspaceName(cwd, lang);
  const asking = stripMarkdown(answer).trim().endsWith('?');
  if (lang === 'en') return asking ? `Workspace ${ws} is asking you.` : `Workspace ${ws} is done.`;
  return asking ? `Workspace ${ws} đang hỏi bạn.` : `Workspace ${ws} xong.`;
}

/**
 * Câu ngắn để đọc khi Claude Code cần người dùng. Cố ý đơn giản: chỉ tên workspace và việc cần làm,
 * vì người nghe đang làm nhiều cửa sổ, chỉ cần biết quay về đâu. Trả về '' nếu sự kiện không cần báo.
 */
export function announcement(input: HookInput, lang: Lang = 'vi'): string {
  const ws = workspaceName(input.cwd, lang);
  const approve = lang === 'en' ? `Workspace ${ws} needs approval.` : `Workspace ${ws} cần approve.`;
  const answer = lang === 'en' ? `Workspace ${ws} needs your answer.` : `Workspace ${ws} cần bạn xác nhận câu trả lời.`;
  const event = input.hook_event_name ?? '';
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') return answer;
  // Tool đặt câu hỏi cũng đi qua bước xin quyền; PreToolUse đã báo rồi nên không báo lần hai.
  if (event === 'PermissionRequest') return input.tool_name === 'AskUserQuestion' ? '' : approve;
  if (event === 'Notification') {
    const type = input.notification_type ?? '';
    if (type === 'permission_prompt') return approve;
    if (type === 'elicitation_dialog') return answer;
  }
  return '';
}
