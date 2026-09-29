/**
 * Đoán xem Copilot Chat có tự duyệt một lệnh terminal không, theo đúng setting auto-approve của VS Code
 * (chat.tools.global.autoApprove, chat.tools.terminal.enableAutoApprove, chat.tools.terminal.autoApprove).
 *
 * Chat gọi hook PreToolUse trước mọi tool, kể cả tool sẽ được tự duyệt, và không có sự kiện "hộp thoại đã hiện".
 * Khi Hands Free tắt, hook chỉ đọc "cần approve" cho lệnh mà VS Code không tự duyệt, và trả 'ask' để hộp thoại
 * chắc chắn hiện (VS Code ép hiện khi hook trả 'ask'). Đoán sai theo hướng "không tự duyệt" chỉ tốn thêm một
 * hộp thoại; đoán sai theo hướng ngược lại thì hook im, như trước. Không bao giờ báo mà không có hộp thoại.
 *
 * Extension đọc setting đã gộp (mặc định + user + workspace) và ghi vào hook-config; hook chỉ so khớp.
 * Bản so khớp là bản rút gọn của VS Code: khoá thường = lệnh con bắt đầu bằng khoá (cả từ), khoá /.../cờ = regex,
 * false = cấm, null = bỏ, { approve, matchCommandLine: true } = so cả dòng lệnh thay vì từng lệnh con.
 */

export type ChatAutoApproveRule = boolean | { approve: boolean; matchCommandLine?: boolean } | null;

export interface ChatAutoApprove {
  /** chat.tools.global.autoApprove: mọi tool tự duyệt. */
  global?: boolean;
  /** chat.tools.terminal.enableAutoApprove: false thì lệnh terminal nào cũng hỏi. */
  terminalEnabled?: boolean;
  /** chat.tools.terminal.autoApprove đã gộp các scope; thiếu thì hook chưa biết gì. */
  rules?: Record<string, ChatAutoApproveRule>;
}

const GLOBAL_KEY = 'chat.tools.global.autoApprove';
const TERMINAL_ENABLED_KEY = 'chat.tools.terminal.enableAutoApprove';
const IGNORE_DEFAULT_KEY = 'chat.tools.terminal.ignoreDefaultAutoApproveRules';
const RULES_KEY = 'chat.tools.terminal.autoApprove';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validRules(value: unknown): Record<string, ChatAutoApproveRule> {
  if (!isRecord(value)) return {};
  const out: Record<string, ChatAutoApproveRule> = {};
  for (const [key, rule] of Object.entries(value)) {
    if (rule === null || typeof rule === 'boolean') out[key] = rule;
    else if (isRecord(rule) && typeof rule.approve === 'boolean') {
      out[key] = { approve: rule.approve, ...(rule.matchCommandLine === true ? { matchCommandLine: true } : {}) };
    }
  }
  return out;
}

/**
 * Gom setting VS Code thành bản cho hook. get = giá trị đã gộp các scope, getDefault = giá trị mặc định của VS Code.
 * ignoreDefaultAutoApproveRules: bỏ những khoá còn nguyên giá trị mặc định (VS Code làm đúng như vậy).
 */
export function chatAutoApproveFrom(get: (key: string) => unknown, getDefault: (key: string) => unknown): ChatAutoApprove {
  const merged = validRules(get(RULES_KEY));
  const rules: Record<string, ChatAutoApproveRule> = {};
  const defaults = get(IGNORE_DEFAULT_KEY) === true ? validRules(getDefault(RULES_KEY)) : {};
  for (const [key, rule] of Object.entries(merged)) {
    if (key in defaults && JSON.stringify(defaults[key]) === JSON.stringify(rule)) continue;
    rules[key] = rule;
  }
  return {
    global: get(GLOBAL_KEY) === true,
    terminalEnabled: get(TERMINAL_ENABLED_KEY) !== false,
    rules,
  };
}

function ruleRegex(key: string): RegExp | undefined {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(key);
  if (!m) return undefined;
  try { return new RegExp(m[1], m[2]); } catch { return undefined; }
}

function keyMatches(key: string, text: string): boolean {
  const re = ruleRegex(key);
  if (re) return re.test(text);
  const k = key.trim();
  return !!k && (text === k || text.startsWith(`${k} `));
}

/**
 * true/false khi đã có quy tắc; undefined khi hook chưa biết setting (extension cũ hay chưa ghi), để nơi gọi tự chọn.
 * Mỗi lệnh con (tách bằng && || ; |) phải khớp một quy tắc cho phép và không khớp quy tắc cấm nào.
 */
export function chatWouldAutoApprove(command: string, cfg: ChatAutoApprove | undefined): boolean | undefined {
  if (!cfg || (cfg.global === undefined && cfg.terminalEnabled === undefined && cfg.rules === undefined)) return undefined;
  if (cfg.global) return true;
  if (cfg.terminalEnabled === false) return false;
  const line = command.trim();
  if (!line) return false;
  const rules = Object.entries(cfg.rules ?? {})
    .map(([key, rule]) => ({ key, approve: typeof rule === 'boolean' ? rule : rule?.approve, whole: typeof rule === 'object' && rule?.matchCommandLine === true }))
    .filter((r): r is { key: string; approve: boolean; whole: boolean } => typeof r.approve === 'boolean');
  const denied = (text: string, whole: boolean) => rules.some((r) => !r.approve && r.whole === whole && keyMatches(r.key, text));
  const allowed = (text: string, whole: boolean) => rules.some((r) => r.approve && r.whole === whole && keyMatches(r.key, text));
  if (denied(line, true)) return false;
  const parts = line.split(/\s*(?:&&|\|\||;|\|)\s*/).map((p) => p.trim());
  if (parts.some((p) => !p || denied(p, false))) return false;
  return parts.every((p) => allowed(p, false)) || allowed(line, true);
}
