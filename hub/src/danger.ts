/** Lệnh và file không bao giờ được approve từ trang web; luôn phải bấm tay trong Claude Code. Viết riêng cho hub. */

// git có thể mang tuỳ chọn trước động từ: git -C repo push, git --no-pager reset --hard.
const GIT = String.raw`\bgit(?:\s+-[cC]\s*\S+|\s+--?\S+)*\s+`;

const DANGEROUS_COMMAND: RegExp[] = [
  /\brm\b[^|&;]*\s(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(\s|$)/,
  /\bdel\s+.*\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /remove-item\b.*-recurse/i,
  new RegExp(`${GIT}push\\b`, 'i'),
  new RegExp(`${GIT}reset\\s+--hard\\b`, 'i'),
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
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const DANGEROUS_FILE =
  /(^|[\\/])\.env(\.[\w.-]+)?$|\.(pem|key|p12|pfx)$|(^|[\\/])\.(npmrc|pypirc|netrc)$|(^|[\\/])\.ssh[\\/]|settings\.json$|(^|[\\/])appsettings(\.[\w.-]+)?\.json$|\.git[\\/]/i;

export function isDangerous(toolName: string | undefined, toolInput: unknown): boolean {
  if (!toolName) return false;
  if (DANGEROUS_TOOLS.has(toolName)) return true;
  const input = (toolInput ?? {}) as { command?: unknown; file_path?: unknown };
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (cmd && DANGEROUS_COMMAND.some((re) => re.test(cmd))) return true;
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  if (file && WRITE_TOOLS.has(toolName) && DANGEROUS_FILE.test(file)) return true;
  return false;
}

/** Một dòng ngắn để hiện trên thẻ: lệnh Bash, đường dẫn file, hoặc JSON rút gọn. */
export function summarizeTool(toolName: string | undefined, toolInput: unknown, max = 120): string {
  if (!toolName || toolInput === undefined || toolInput === null) return '';
  const input = toolInput as { command?: unknown; file_path?: unknown };
  let s = '';
  if (typeof input.command === 'string') s = input.command;
  else if (typeof input.file_path === 'string') s = input.file_path;
  else {
    try {
      s = JSON.stringify(toolInput);
    } catch {
      s = String(toolInput);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
