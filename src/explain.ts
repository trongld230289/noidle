import { findExecutable } from './findTool';
import { runCli as defaultRunCli, type CliDeps } from './translate';

/**
 * Quét một từ / đoạn (terminal hay editor) rồi bấm phím tắt: Haiku qua Claude Code CLI người dùng đang dùng giải nghĩa
 * ngắn bằng tiếng Việt. Không cần API key. Bỏ setting của user (plugin, hook, MCP) vì chúng làm mỗi lần mất ~39 giây
 * thay vì ~8 giây (đo 8/10/2026); --bare nhanh hơn nữa nhưng chỉ chạy với API key, không với tài khoản đăng nhập.
 */
export const EXPLAIN_CLI_ARGS = [
  '-p', '--model', 'haiku', '--output-format', 'text',
  '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--disable-slash-commands',
];

/**
 * Không có Claude Code thì dùng Copilot CLI (`copilot`) của người dùng, cũng không cần API key. Prompt đưa qua stdin
 * (không dùng -p để khỏi lo quote). --silent chỉ trả câu trả lời; --allow-all-tools bắt buộc cho chế độ không tương
 * tác (prompt giải nghĩa không gọi tool nào); --disable-builtin-mcps và --log-level none cho nhanh và output sạch.
 */
export const EXPLAIN_COPILOT_ARGS = ['--silent', '--allow-all-tools', '--disable-builtin-mcps', '--log-level', 'none'];
export const EXPLAIN_MAX_CHARS = 2000;

export function explainPrompt(text: string): string {
  return [
    'Giải thích ngắn gọn bằng tiếng Việt nghĩa của đoạn dưới đây, hiểu theo ngữ cảnh lập trình / phần mềm.',
    'Một từ hay cụm từ: nêu nghĩa trong 1-2 câu. Câu hay đoạn dài: dịch sang tiếng Việt, giữ nguyên thuật ngữ kỹ thuật.',
    'Nếu đoạn đã là tiếng Việt thì dịch sang tiếng Anh. Chỉ trả lời nội dung, không markdown, không mở đầu.',
    '',
    text.slice(0, EXPLAIN_MAX_CHARS),
  ].join('\n');
}

export type ExplainResult = { ok: true; text: string } | { ok: false; reason: string };

/** Claude Code trước (Haiku rẻ, nhanh), không có thì Copilot CLI. Mỗi backend dùng cờ riêng, prompt chung qua stdin. */
export async function explainSelection(selection: string, deps: CliDeps = {}): Promise<ExplainResult> {
  const text = selection.trim();
  if (!text) return { ok: false, reason: 'empty' };
  const find = deps.find ?? ((name: string) => findExecutable(name));
  const claude = await find('claude');
  const backend = claude
    ? { bin: claude, args: EXPLAIN_CLI_ARGS }
    : await find('copilot').then((copilot) => (copilot ? { bin: copilot, args: EXPLAIN_COPILOT_ARGS } : undefined));
  if (!backend) return { ok: false, reason: 'no-cli' };
  try {
    const out = await (deps.runCli ?? defaultRunCli)(backend.bin, backend.args, explainPrompt(text));
    return { ok: true, text: out.trim() };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export type ExplainSource = 'editor' | 'terminal' | 'chat' | 'clipboard';

export interface SelectionDeps {
  editorSelection(): string;
  readClipboard(): PromiseLike<string>;
  writeClipboard(text: string): PromiseLike<void>;
  copySelection(source: 'terminal' | 'chat'): PromiseLike<unknown>;
}

export async function captureExplainSelection(source: ExplainSource, deps: SelectionDeps): Promise<string> {
  if (source === 'editor') return deps.editorSelection();
  // 'clipboard': người dùng đã Ctrl+C sẵn (editor/terminal/chat đều nhận). Đọc thẳng clipboard, không đụng vùng chọn —
  // terminal TUI (Copilot/Claude CLI) vẽ lại liên tục làm mất vùng chọn, nên không thể dựa vào copySelection ở đó.
  if (source === 'clipboard') return deps.readClipboard();
  const saved = await deps.readClipboard();
  try {
    // Copy không có vùng chọn có thể không ghi gì: xoá tạm để không nhận nhầm clipboard cũ.
    await deps.writeClipboard('');
    await deps.copySelection(source);
    return await deps.readClipboard();
  } finally {
    await deps.writeClipboard(saved);
  }
}
