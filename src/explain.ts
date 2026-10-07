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

export async function explainSelection(selection: string, deps: CliDeps = {}): Promise<ExplainResult> {
  const text = selection.trim();
  if (!text) return { ok: false, reason: 'empty' };
  const bin = await (deps.find ?? ((name: string) => findExecutable(name)))('claude');
  if (!bin) return { ok: false, reason: 'no-claude' };
  try {
    const out = await (deps.runCli ?? defaultRunCli)(bin, EXPLAIN_CLI_ARGS, explainPrompt(text));
    return { ok: true, text: out.trim() };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
