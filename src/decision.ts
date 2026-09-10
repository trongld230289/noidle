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

/** Từ câu người dùng nói, trả về allow, deny, hoặc undefined nếu không rõ. Từ chối được ưu tiên khi lẫn cả hai. */
export function parseApproval(text: string): Approval | undefined {
  const t = strip(text);
  if (!t) return undefined;
  const has = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t);
  if (DENY.some(has)) return 'deny';
  if (ALLOW.some(has)) return 'allow';
  return undefined;
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
