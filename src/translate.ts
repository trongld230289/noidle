import { spawn } from 'child_process';
import * as os from 'os';
import { findExecutable } from './findTool';
import type { RecapTranslator } from './recapPrompt';

/**
 * Backend dịch noIdle.recapPrompt bằng Claude Code CLI người dùng đang dùng: không cần API key, tốn một lần
 * quota rất nhỏ. Prompt đưa qua stdin để khỏi lo ngoặc kép / xuống dòng trên dòng lệnh.
 * Backend Copilot (vscode.lm) nằm trong extension.ts vì cần API của VS Code.
 */

export const CLAUDE_CLI_ARGS = ['-p', '--output-format', 'text'];
const CLI_TIMEOUT_MS = 90_000;

export interface CliDeps {
  find?: (name: string) => Promise<string | undefined>;
  /** Chạy binary với args, ghi input vào stdin, trả stdout; lỗi hay exit khác 0 thì reject. */
  runCli?: (file: string, args: string[], input: string) => Promise<string>;
}

/**
 * claude.cmd trên Windows phải chạy qua shell (Node từ chối spawn .cmd trực tiếp). Ghép sẵn một chuỗi lệnh thay vì
 * đưa args kèm shell:true (Node cảnh báo DEP0190); args chỉ là cờ cố định nên chỉ cần quote đường dẫn.
 */
export function runCli(file: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    // NOIDLE_INTERNAL: hook NoIdle của người dùng (được kế thừa) thấy là thoát ngay, không tắt mic, không đọc "done" giả.
    // cwd ngoài project: không kéo CLAUDE.md/memory của project vào, không để lại phiên lạ trong lịch sử project.
    const opts = {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NOIDLE_INTERNAL: '1' },
      cwd: os.tmpdir(),
    };
    const child = viaShell ? spawn(`"${file}" ${args.join(' ')}`, [], { ...opts, shell: true }) : spawn(file, args, opts);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`quá ${CLI_TIMEOUT_MS / 1000}s`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.trim().slice(0, 200)}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export function claudeCliTranslator(deps: CliDeps = {}): RecapTranslator {
  const find = deps.find ?? ((name: string) => findExecutable(name));
  const run = deps.runCli ?? runCli;
  return {
    name: 'claude',
    async run(prompt) {
      const bin = await find('claude');
      if (!bin) return undefined;
      try {
        return await run(bin, CLAUDE_CLI_ARGS, prompt);
      } catch {
        return undefined;
      }
    },
  };
}
