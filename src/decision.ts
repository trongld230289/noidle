/** Hiểu câu trả lời bằng giọng cho hộp thoại xin quyền, và chặn lệnh nguy hiểm khỏi approve bằng giọng. */

export type Approval = 'allow' | 'deny';

const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/['’]/g, '') // don't → dont, để so với bảng từ
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// So khớp trên chữ không dấu để Whisper viết "đồng ý" hay "dong y" đều nhận.
const DENY = [
  'tu choi', 'khong dong y', 'khong cho', 'khong duoc', 'dung lai', 'dung', 'huy', 'deny', 'reject', 'cancel', 'no', 'khong', 'thoi',
];
const ALLOW = [
  'approve', 'approved', 'go ahead', 'do it', 'sure', 'yeah', 'yep', 'yup', 'dong y', 'cho phep', 'duyet', 'ok', 'okay', 'oke', 'yes', 'lam di', 'chay di', 'tiep di', 'tiep tuc', 'duoc', 'ung', 'lam tiep',
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
  if (/^(huỷ|hủy|huy|thôi|thoi|bỏ|bo|dừng|dung|xong|cancel|stop|never ?mind|forget it)[\s.!]*$/iu.test(text)) {
    return { command: 'cancel', text: '' };
  }
  const m = /^(.*?)(?:^|[\s,.]+)(gửi đi|gửi|gui di|gui|send)[\s.!]*$/iu.exec(text);
  if (m) return { command: 'send', text: m[1].trim() };
  return { text };
}

// Phủ định đứng trước hoặc trong câu ("do not approve", "not okay", "đừng ok"): coi là từ chối, không phải đồng ý.
const NEGATION = ['not', 'dont', 'do not', 'never', 'nope', 'nah', 'dung', 'khong', 'cham'];
// Hoãn hoặc lưỡng lự ("approve later", "ok wait", "để sau", "khoan", "chưa"): không rõ, để hộp thoại hiện cho bấm tay.
const DEFER = ['later', 'wait', 'hold on', 'de sau', 'khoan', 'khoan da', 'chua', 'de xem', 'lat nua', 'not sure', 'maybe'];

/**
 * Từ câu người dùng nói, trả về allow, deny, hoặc undefined nếu không rõ.
 * Chỉ nhận đồng ý khi câu không có phủ định hay hoãn; từ chối được ưu tiên khi lẫn cả hai.
 */
export function parseApproval(text: string): Approval | undefined {
  const raw = text.trim();
  const t = strip(raw);
  if (!t) return undefined;
  const words = t.split(' ');
  const has = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t);
  // Câu hỏi ("được không?", "can you approve") hay điều kiện ("only after tests pass"): không rõ, để bấm tay,
  // trừ khi có từ chối rõ ràng, vì từ chối là lựa chọn an toàn.
  const question = raw.includes('?') || QUESTION_START.includes(words[0]) || (words.length > 1 && QUESTION_END.includes(words[words.length - 1]) && !DENY.includes(words[0]));
  const conditional = CONDITION.some(has);
  // Câu mở đầu bằng từ chối hay phủ định ("do not approve", "không, đừng") là từ chối dù có dạng câu hỏi ("do" cũng là từ hỏi).
  const startsDeny = [...DENY, ...NEGATION].some((w) => t === w || t.startsWith(`${w} `));
  if (DENY.some(has) || NEGATION.some(has)) return question && !startsDeny ? undefined : 'deny';
  if (question || conditional || DEFER.some(has)) return undefined;
  // Đồng ý chỉ khi CẢ CÂU là một mẫu xác nhận cho phép, quanh đó chỉ được có từ đệm ("ừ approve đi", "yes please").
  // Câu chứa từ đồng ý nhưng kể chuyện khác ("was that okay", "approve tomorrow", "ai đồng ý") không tính.
  if (CONFIRM_RE.test(t)) return 'allow';
  return undefined;
}

// Từ đệm được phép đứng quanh lời xác nhận. Không chứa gì mang nghĩa khác.
const FILLER = ['u', 'o', 'oh', 'a', 'ok', 'okay', 'yes', 'yeah', 'di', 'nhe', 'nha', 'luon', 'please', 'thanks', 'thank you', 'cam on', 'ban', 'em', 'anh', 'chi'];
// Sau từ đồng ý đầu tiên cho lặp thêm từ đồng ý ("approve, approve, approve": người dùng nói dằn lại khi mic chậm).
const CONFIRM_RE = new RegExp(`^(?:(?:${FILLER.join('|')}) )*(?:${ALLOW.join('|')})(?: (?:${[...FILLER, ...ALLOW].join('|')}))*$`);
const QUESTION_START = ['is', 'are', 'can', 'could', 'should', 'do', 'does', 'did', 'will', 'would', 'what', 'why', 'how', 'when', 'co', 'lieu'];
// "được không", "approve được không", "ok chứ", "ok hả"
const QUESTION_END = ['khong', 'chu', 'ha', 'a', 'nhi', 'hong'];
const CONDITION = ['after', 'if', 'when', 'once', 'only', 'unless', 'before', 'until', 'then', 'neu', 'khi', 'sau khi', 'truoc khi', 'chi', 'luc', 'roi moi', 'xong roi', 'ma khoan'];

/**
 * Danh sách trắng cho approve bằng giọng: chỉ tool và lệnh đã biết là lành mới được duyệt bằng giọng;
 * tool lạ (kể cả MCP), lệnh chưa phân loại, hay bất cứ thứ gì isDangerous đều phải bấm tay. Từ chối bằng giọng thì luôn được.
 */
const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent']);
const SAFE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/**
 * Tách một lệnh thành mảng đối số như shell: bỏ nháy đơn/kép, giữ khoảng trắng trong nháy.
 * Trả về undefined nếu có thứ không đọc an toàn được: nháy lệch, xuống dòng, biến ($), lệnh con (` hay $()),
 * chuyển hướng (< >), ngoặc, backslash. Kiểm tra trên đối số thật, không phải chuỗi thô, vì shell bỏ nháy trước khi chạy:
 * `find . "-delete"` và `find . -delete` là một.
 */
export function shellArgs(cmd: string): string[] | undefined {
  if (/[\r\n`$<>(){}\\]/.test(cmd)) return undefined;
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return undefined;
  if (has) out.push(cur);
  return out;
}

const NPM_SCRIPT = /^(test|tests|lint|build|typecheck|check|format|compile|dev|test:[\w-]+|lint:[\w-]+|build:[\w-]+)$/;
const isFlag = (a: string) => /^-[\w=.:-]*$/.test(a);
// Đối số không được mang ký tự nối lệnh: khi nằm trong nháy chúng lọt qua bước tách ở && ; |.
const cleanArg = (a: string) => !/[|;&]/.test(a);
const all = (args: string[], ok: (a: string) => boolean) => args.every((a) => cleanArg(a) && ok(a));
const any = () => true;
const flagsOnly = (args: string[]) => all(args, isFlag);

/**
 * Quy tắc từng lệnh cho approve bằng giọng: nhận mảng đối số (sau tên lệnh), trả true nếu toàn bộ lệnh là lành.
 * Không có quy tắc cho rm, curl, node script, deploy, publish...: chưa phân loại thì bấm tay.
 */
const RULES: Record<string, (args: string[]) => boolean> = {
  npm: npmRule, pnpm: npmRule, yarn: npmRule, bun: npmRule,
  npx: (a) =>
    (['vitest', 'jest', 'tsc', 'eslint', 'prettier', 'esbuild'].includes(a[0]) && all(a.slice(1), any)) ||
    (a[0] === 'vsce' && a[1] === 'package' && all(a.slice(2), any)) ||
    (a[0] === 'playwright' && a[1] === 'test' && all(a.slice(2), any)),
  pytest: (a) => all(a, any),
  cargo: (a) => ['test', 'build', 'check', 'clippy'].includes(a[0]) && all(a.slice(1), any),
  go: (a) => ['test', 'build', 'vet'].includes(a[0]) && all(a.slice(1), any),
  dotnet: (a) => ['test', 'build'].includes(a[0]) && all(a.slice(1), any),
  mvn: (a) => ['test', 'package', 'verify'].includes(a[0]) && all(a.slice(1), any),
  gradle: (a) => ['test', 'build'].includes(a[0]) && all(a.slice(1), any),
  make: (a) => (a.length === 0 || ['test', 'build', 'check', 'lint'].includes(a[0])) && flagsOnly(a.slice(1)),
  git: gitRule,
  find: (a) => all(a, (x) => !/^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(x)),
  ls: (a) => all(a, any), dir: (a) => all(a, any), pwd: (a) => all(a, any), tree: (a) => all(a, any), which: (a) => all(a, any), where: (a) => all(a, any),
  wc: (a) => all(a, any), head: (a) => all(a, any), tail: (a) => all(a, any), cat: (a) => all(a, any), type: (a) => all(a, any), echo: (a) => all(a, any),
  grep: (a) => all(a, any), rg: (a) => all(a, any), findstr: (a) => all(a, any),
};

function npmRule(a: string[]): boolean {
  if (['test', 'ci', 'lint', 'build'].includes(a[0])) return all(a.slice(1), any);
  if (a[0] === 'run') return NPM_SCRIPT.test(a[1] ?? '') && all(a.slice(2), any);
  // install không kèm tên gói: cài thêm gói lạ là chuyện phải xem tay.
  if (a[0] === 'install' || a[0] === 'i') return flagsOnly(a.slice(1));
  return false;
}

function gitRule(a: string[]): boolean {
  const sub = a[0];
  const rest = a.slice(1);
  if (['status', 'diff', 'log', 'show', 'blame', 'fetch', 'rev-parse'].includes(sub)) return all(rest, any);
  if (sub === 'stash') return rest.length === 1 && rest[0] === 'list';
  if (sub === 'remote') return rest.length === 1 && rest[0] === '-v';
  if (sub === 'branch') return all(rest, (x) => ['--list', '-a', '-v', '-vv', '--show-current', '-r'].includes(x));
  if (sub === 'add') return all(rest, any);
  if (sub === 'commit') {
    // Chỉ -m/-am/--message với nội dung; không amend, no-verify, hay cờ lạ.
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (!cleanArg(x)) return false;
      if (x === '-m' || x === '-am' || x === '--message') {
        if (rest[i + 1] === undefined) return false;
        i++;
        continue;
      }
      if (/^--message=/.test(x) || x === '-a') continue;
      return false;
    }
    return rest.some((x) => x === '-m' || x === '-am' || x === '--message' || x.startsWith('--message='));
  }
  return false;
}

export function voiceApprovable(toolName: string | undefined, toolInput: unknown): boolean {
  if (!toolName || isDangerous(toolName, toolInput)) return false;
  if (SAFE_TOOLS.has(toolName)) return true;
  const input = (toolInput ?? {}) as { command?: unknown; file_path?: unknown };
  if (SAFE_WRITE_TOOLS.has(toolName)) return typeof input.file_path === 'string' && input.file_path.length > 0;
  if (toolName !== 'Bash' || typeof input.command !== 'string') return false;
  const cmd = input.command.trim();
  if (!cmd || cmd.length > 300) return false;
  // Tách các lệnh con nối bằng && || ; | rồi xét từng lệnh trên đối số thật.
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts.every((p) => {
    const args = shellArgs(p);
    if (!args || !args.length) return false;
    const rule = RULES[args[0]];
    return !!rule && rule(args.slice(1));
  });
}

/**
 * JSON trả cho Claude Code ở hook PermissionRequest. Sự kiện này dùng decision.behavior (khác PreToolUse dùng
 * permissionDecision); trả sai tên trường thì Claude Code bỏ qua và hộp thoại vẫn hiện dù đã đọc "đã approve".
 */
export function permissionRequestOutput(decision: Approval, reason: string): {
  hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: Approval; message?: string } };
} {
  const d: { behavior: Approval; message?: string } = { behavior: decision };
  if (decision === 'deny') d.message = reason;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } };
}

const NUMBER_WORDS: Record<string, number> = {
  mot: 1, nhat: 1, hai: 2, nhi: 2, ba: 3, bon: 4, tu: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  a: 1, b: 2, c: 3, d: 4, e: 5,
};
// So trên chữ còn dấu: bỏ dấu thì "thời gian" thành "thoi" và bị hiểu là "thôi".
const SKIP_RE = /(^|\s)(bỏ qua|bo qua|không chọn|khong chon|thôi|huỷ|hủy|skip|cancel|để sau|de sau)(\s|$)/iu;

export function isChoiceCancellation(text: string): boolean {
  return SKIP_RE.test(text.normalize('NFC').toLowerCase().replace(/[.,!?]/g, ' '));
}

export function isAmbiguousChoice(text: string, labels: string[]): boolean {
  const normalized = strip(text);
  if (labels.some((label) => strip(label) === normalized)) return false;
  return text.includes('?') || [...NEGATION, ...DEFER, 'no'].some((phrase) =>
    new RegExp(`(^|\\s)${phrase}(\\s|$)`).test(normalized));
}

/**
 * Từ câu người dùng nói, tìm các lựa chọn được chọn (chỉ số bắt đầu từ 0) trong danh sách nhãn.
 * Hiểu số ("một", "2", "thứ ba"), chữ cái ("b"), "tất cả", hoặc nhắc lại tên lựa chọn.
 * Trả về [] nếu người dùng bảo bỏ qua, undefined nếu không hiểu.
 */
export function parseChoice(text: string, labels: string[]): number[] | undefined {
  const t = strip(text);
  if (!t) return undefined;
  if (isChoiceCancellation(text)) return [];
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
// git có thể mang tuỳ chọn trước động từ: git -C repo push, git -C "my repo" push, git --no-pager push, git -c a=b clean.
const GIT = String.raw`\bgit(?:\s+-[cC]\s*(?:"[^"]*"|'[^']*'|\S+)|\s+--?\S+)*\s+`;
const DANGEROUS_COMMAND = [
  /\brm\b[^|&;]*\s(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(\s|$)/, // rm -rf, rm -R, rm --recursive, rm --force -r
  /\bdel\s+.*\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /remove-item\b.*-recurse/i,
  new RegExp(`${GIT}push\\b`, 'i'),
  new RegExp(`${GIT}reset\\b[^|&;]*--hard\\b`, 'i'),
  new RegExp(`${GIT}clean\\b`, 'i'),
  new RegExp(`${GIT}checkout\\s+--\\s`, 'i'),
  new RegExp(`${GIT}branch\\s+-[dD]\\b`, 'i'),
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
  // .env và mọi biến thể (.env.production, .env.local), khoá, chứng chỉ, cấu hình npm/pypi/ssh, settings và appsettings.
  if (
    file &&
    /(^|[\\/])\.env(\.[\w.-]+)?$|\.(pem|key|p12|pfx)$|(^|[\\/])\.(npmrc|pypirc|netrc)$|(^|[\\/])\.ssh[\\/]|settings\.json$|(^|[\\/])appsettings(\.[\w.-]+)?\.json$|\.git[\\/]/i.test(
      file,
    )
  ) {
    return true;
  }
  return false;
}
