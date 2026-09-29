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

/**
 * Agent nền còn chạy: Agent tool tách nền cho kết quả có isAsync + agentId. Xong thì Claude Code gửi một
 * <task-notification> mang task-id đó (completed hay failed); TaskStop dừng sớm; SendMessage tới agent đã xong
 * thì nó chạy tiếp và sẽ báo lại. Claude kết thúc lượt mà còn agent nền là đang chờ, chưa phải xong.
 *
 * Notification nằm ở nhiều loại dòng: tin nhắn user khi Claude rảnh, còn lúc Claude đang làm thì là dòng
 * attachment hay queue-operation. Nên tìm thẻ trên cả dòng thô, không phân biệt loại.
 *
 * Lệnh Bash chạy nền (backgroundTaskId) chỉ tính khi được bật TRONG LƯỢT VỪA KẾT THÚC và chưa có notification:
 * Claude bật vòng chờ ("đợi test chạy xong") rồi ngừng để đợi, báo "done" lúc đó là sai. Bật ở lượt trước thì
 * không tính nữa: server dev chạy hoài không bao giờ "xong", tính mãi là câm mãi.
 *
 * Agent cũng phải có đường thoát, không thì một agent mất notification làm hook câm hết phần còn lại của phiên
 * (thấy thật: Claude lấy kết quả bằng TaskOutput thì Claude Code không gửi notification nữa; agent chết hay
 * phiên mở lại bằng --resume cũng vậy). Nên: TaskOutput trả status khác running là hết chờ, và người dùng tự gõ
 * prompt mới thì bỏ các agent còn treo từ lượt trước. Notification hay tin nhắn từ agent mở lượt thì vẫn chờ.
 */
export function pendingBackgroundTasks(jsonl: string): string[] {
  const launched = new Set<string>();
  const pending = new Set<string>();
  let bashThisTurn = new Set<string>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: string; isMeta?: unknown; message?: { content?: unknown }; toolUseResult?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const tr = entry.toolUseResult as
      | { isAsync?: unknown; agentId?: unknown; backgroundTaskId?: unknown; task?: { task_id?: unknown; status?: unknown } }
      | undefined;
    if (tr && typeof tr === 'object' && tr.isAsync === true && typeof tr.agentId === 'string') {
      launched.add(tr.agentId);
      pending.add(tr.agentId);
    }
    if (tr && typeof tr === 'object' && typeof tr.backgroundTaskId === 'string') bashThisTurn.add(tr.backgroundTaskId);
    // TaskOutput: Claude đã tự lấy kết quả (completed/failed/killed), việc đó xong; còn running thì vẫn chờ.
    const task = tr && typeof tr === 'object' ? tr.task : undefined;
    if (task && typeof task.task_id === 'string' && typeof task.status === 'string' && task.status !== 'running') {
      pending.delete(task.task_id);
      bashThisTurn.delete(task.task_id);
    }
    // Lượt mới bắt đầu ở tin nhắn user thật (prompt hay notification), không phải tool_result.
    // Nội dung skill/system chèn giữa lượt (isMeta) không phải lượt mới.
    if (entry.type === 'user' && entry.isMeta !== true && isUserTurnStart(entry.message?.content)) {
      bashThisTurn = new Set();
      if (isTypedPrompt(entry.message?.content)) pending.clear();
    }
    for (const m of line.matchAll(/<task-notification>[\s\S]*?<task-id>\s*([^<]+?)\s*<\/task-id>/g)) {
      // Dòng JSON thô: thẻ có thể nằm trong chuỗi đã escape ("\n" là hai ký tự), task-id là chữ số nên không bị ảnh hưởng.
      const id = m[1].replace(/\\n/g, '').trim();
      pending.delete(id);
      bashThisTurn.delete(id);
    }
    const content = entry.message?.content;
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as { type?: string; name?: string; input?: { task_id?: unknown; to?: unknown } }[]) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name === 'TaskStop' && typeof b.input?.task_id === 'string') pending.delete(b.input.task_id);
        if (b.name === 'SendMessage' && typeof b.input?.to === 'string' && launched.has(b.input.to)) pending.add(b.input.to);
      }
    }
  }
  return [...pending, ...bashThisTurn];
}

/**
 * Người dùng tự gõ (hay nói) câu này, không phải Claude Code chèn: không phải task-notification của việc nền,
 * không phải tin nhắn từ agent/phiên khác. Chỉ những câu này mới bỏ các agent còn treo từ lượt trước.
 */
function isTypedPrompt(content: unknown): boolean {
  const text = (typeof content === 'string' ? content : joinTextBlocks(content)).trimStart();
  if (!text) return false;
  if (text.startsWith('<task-notification>')) return false;
  if (text.startsWith('Another Claude session') || /<agent-message\b/.test(text)) return false;
  return true;
}

/** Tin nhắn user mở lượt mới: nội dung là chuỗi, hoặc mảng có khối text mà không có tool_result. */
function isUserTurnStart(content: unknown): boolean {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  const blocks = content as { type?: string }[];
  return blocks.some((b) => b?.type === 'text') && !blocks.some((b) => b?.type === 'tool_result');
}

/**
 * Prompt người dùng gõ lúc Claude đang làm nằm chờ trong hàng đợi (dòng queue-operation enqueue). Claude kết thúc
 * lượt mà hàng đợi còn câu thì nó làm ngay câu đó, chưa phải "done". dequeue là đã lấy ra làm lượt mới; remove
 * (absorbed_mid_turn) là đã gộp vào lượt đang làm. Trả số câu còn chờ.
 */
export function queuedPrompts(jsonl: string): number {
  const queue: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes('"queue-operation"')) continue;
    let entry: { type?: string; operation?: string; content?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'queue-operation') continue;
    if (entry.operation === 'enqueue') queue.push(typeof entry.content === 'string' ? entry.content : '');
    else if (entry.operation === 'dequeue') queue.length = 0;
    else if (entry.operation === 'remove') {
      const i = queue.indexOf(typeof entry.content === 'string' ? entry.content : '');
      if (i >= 0) queue.splice(i, 1);
    }
  }
  return queue.length;
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

/** Chèn một lần khi phiên đang recap đổi sang announce: hướng dẫn cũ còn trong lịch sử nên phải bảo Claude thôi. */
export function promptStopRecap(lang: Lang = 'vi'): string {
  return lang === 'en'
    ? `The ${SPEAK_MARK} section is no longer needed from now on; answer normally without it.`
    : `Từ giờ không cần viết phần ${SPEAK_MARK} nữa; trả lời như bình thường, không có phần đó.`;
}

/** Các câu hook nói ra (và lý do trả về cho Claude) khi approve hoặc chọn đáp án bằng giọng, theo ngôn ngữ. */
export interface Spoken {
  dangerous: (announcement: string) => string;
  notSafe: (announcement: string) => string;
  sayApproveOrDeny: (announcement: string) => string;
  notHeardPress: string;
  unclearPress: string;
  /** Lý do trả về Chat khi hook chỉ đọc "cần approve" và ép hộp thoại hiện (Hands Free tắt). */
  announcedByVoice: string;
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
  announcedByVoice: 'NoIdle đã đọc thông báo này bằng giọng nói',
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
  announcedByVoice: 'NoIdle announced this request by voice',
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
  return asking ? `Workspace ${ws} đang hỏi bạn.` : `Workspace ${ws} xong rồi nhé.`;
}

/**
 * Câu ngắn để đọc khi Claude Code cần người dùng. Cố ý đơn giản: chỉ tên workspace và việc cần làm,
 * vì người nghe đang làm nhiều cửa sổ, chỉ cần biết quay về đâu. Trả về '' nếu sự kiện không cần báo.
 */
const BRIEF_WORDS = 3;
const BRIEF_WORD_MAX = 24;

/**
 * Câu ngắn về tool đang xin quyền, đọc sau câu "Workspace X cần approve": Copilot Chat gửi nguyên câu lệnh
 * (có khi dài ba dòng đường dẫn và tham số), đọc hết thì nghe ghê. Chỉ đọc vài từ đầu để biết là lệnh gì:
 * bỏ "cd <thư mục> &&" mở đầu, đường dẫn chỉ lấy tên file, từ quá dài thì cắt. Tool file thì đọc tên file.
 */
export function briefTool(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  const words: string[] = [];
  if (typeof toolInput?.command === 'string') {
    const command = toolInput.command.trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '');
    for (const raw of command.split(/\s+/)) {
      const word = raw.replace(/^["']+|["']+$/g, '');
      if (!word) continue;
      words.push(shortWord(word));
      if (words.length >= BRIEF_WORDS) break;
    }
  } else if (typeof toolInput?.file_path === 'string' && toolInput.file_path.trim()) {
    words.push(shortWord((toolInput.file_path as string).trim()));
  }
  return words.length ? `${toolName}: ${words.join(' ')}` : toolName;
}

function shortWord(word: string): string {
  const base = /[\\/]/.test(word) ? word.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || word : word;
  return base.length > BRIEF_WORD_MAX ? `${base.slice(0, BRIEF_WORD_MAX - 1)}…` : base;
}

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
