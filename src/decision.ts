/** Hiểu câu trả lời bằng giọng cho hộp thoại xin quyền, và chặn lệnh nguy hiểm khỏi approve bằng giọng. */

export type Approval = 'allow' | 'deny';

const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// So khớp trên chữ không dấu để Whisper viết "đồng ý" hay "dong y" đều nhận.
const DENY = [
  'tu choi', 'khong dong y', 'khong cho', 'khong duoc', 'dung lai', 'dung', 'huy', 'deny', 'reject', 'cancel', 'no', 'khong', 'thoi',
];
const ALLOW = [
  'approve', 'approved', 'dong y', 'cho phep', 'duyet', 'ok', 'okay', 'oke', 'yes', 'lam di', 'chay di', 'tiep di', 'tiep tuc', 'duoc', 'ung', 'lam tiep',
];

export interface VoiceCommand {
  command?: 'send' | 'cancel';
  /** Chữ còn lại sau khi bỏ từ lệnh. */
  text: string;
}

/**
 * Lệnh nói trong hands-free, xét trên chữ Whisper thô của một cụm: "gửi" hoặc "send" ở cuối cụm thì gửi ngay
 * (phần trước đó vẫn được chèn); cụm chỉ là "huỷ", "thôi", "dừng"... thì tắt mic, không gửi.
 * Không dùng \b vì JS không coi chữ có dấu là ký tự từ.
 */
export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = raw.trim();
  if (/^(huỷ|hủy|huy|thôi|thoi|bỏ|bo|dừng|dung|xong)[\s.!]*$/iu.test(text)) return { command: 'cancel', text: '' };
  const m = /^(.*?)(?:^|[\s,.]+)(gửi đi|gửi|gui di|gui|send)[\s.!]*$/iu.exec(text);
  if (m) return { command: 'send', text: m[1].trim() };
  return { text };
}

/** Từ câu người dùng nói, trả về allow, deny, hoặc undefined nếu không rõ. Từ chối được ưu tiên khi lẫn cả hai. */
export function parseApproval(text: string): Approval | undefined {
  const t = strip(text);
  if (!t) return undefined;
  const has = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t);
  if (DENY.some(has)) return 'deny';
  if (ALLOW.some(has)) return 'allow';
  return undefined;
}

const NUMBER_WORDS: Record<string, number> = {
  mot: 1, nhat: 1, hai: 2, nhi: 2, ba: 3, bon: 4, tu: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  a: 1, b: 2, c: 3, d: 4, e: 5,
};
// So trên chữ còn dấu: bỏ dấu thì "thời gian" thành "thoi" và bị hiểu là "thôi".
const SKIP_RE = /(^|\s)(bỏ qua|bo qua|không chọn|khong chon|thôi|huỷ|hủy|skip|cancel|để sau|de sau)(\s|$)/iu;

/**
 * Từ câu người dùng nói, tìm các lựa chọn được chọn (chỉ số bắt đầu từ 0) trong danh sách nhãn.
 * Hiểu số ("một", "2", "thứ ba"), chữ cái ("b"), "tất cả", hoặc nhắc lại tên lựa chọn.
 * Trả về [] nếu người dùng bảo bỏ qua, undefined nếu không hiểu.
 */
export function parseChoice(text: string, labels: string[]): number[] | undefined {
  const t = strip(text);
  if (!t) return undefined;
  if (SKIP_RE.test(text.normalize('NFC').toLowerCase().replace(/[.,!?]/g, ' '))) return [];
  if (/(^|\s)(tat ca|ca hai|ca ba|all)(\s|$)/.test(t)) return labels.map((_, i) => i);

  const picked = new Set<number>();
  // Nhắc tên lựa chọn: ưu tiên vì rõ nghĩa hơn số.
  labels.forEach((label, i) => {
    const words = strip(label).split(' ').filter((w) => w.length > 1);
    if (!words.length) return;
    const hit = words.filter((w) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t)).length;
    // Trùng hết, hoặc trùng ít nhất 2 từ và từ nửa nhãn trở lên ("kiểu chat" đủ để nhận "Nhật ký kiểu chat").
    if (hit === words.length || (hit >= 2 && hit >= Math.ceil(words.length / 2))) picked.add(i);
  });
  if (picked.size) return [...picked].sort();

  // Số hoặc chữ cái: "chọn 2", "một và ba", "thứ hai", "b".
  for (const tok of t.split(' ')) {
    const n = /^\d+$/.test(tok) ? Number(tok) : NUMBER_WORDS[tok];
    if (n && n >= 1 && n <= labels.length) picked.add(n - 1);
  }
  return picked.size ? [...picked].sort() : undefined;
}

// Lệnh không bao giờ được duyệt bằng giọng, luôn phải bấm tay.
const DANGEROUS_COMMAND = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, // rm -rf
  /\brm\s+-r\b/i,
  /\bdel\s+.*\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /remove-item\b.*-recurse/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bgit\s+branch\s+-[dD]\b/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bformat\b\s+[a-z]:/i,
  /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/i,
  /\bnpm\s+publish\b|\bvsce\s+publish\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune)\b/i,
  /\bkubectl\s+delete\b|\baz\s+.*\bdelete\b|\baws\s+.*\bdelete\b/i,
  /\bsudo\b/i,
];

const DANGEROUS_TOOLS = new Set(['KillShell', 'EndConversation']);

/** Tool call này có thuộc loại không cho approve bằng giọng không. */
export function isDangerous(toolName: string | undefined, toolInput: unknown): boolean {
  if (!toolName) return false;
  if (DANGEROUS_TOOLS.has(toolName)) return true;
  const input = (toolInput ?? {}) as { command?: unknown; file_path?: unknown };
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (cmd && DANGEROUS_COMMAND.some((re) => re.test(cmd))) return true;
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  if (file && /\.(env|pem|key)$|settings\.json$|\.git[\\/]/i.test(file)) return true;
  return false;
}
