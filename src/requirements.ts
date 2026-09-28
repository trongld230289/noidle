/**
 * Kiểm tra máy có `node` và `ffplay` để hook chạy được. Hook là script node: thiếu node thì Claude Code và
 * Copilot Chat báo lỗi hook ở mọi lượt, nên extension không ghi hook khi thiếu. Thiếu ffplay thì hook vẫn nháy
 * cửa sổ, chỉ không phát tiếng.
 */
import { execFile } from 'child_process';

export type CommandRunner = (cmd: string, args: string[], done: (err: Error | null) => void) => void;

const defaultRunner: CommandRunner = (cmd, args, done) => {
  execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err) => done(err));
};

/** Chạy `cmd args` và trả true nếu tiến trình khởi động được, không quan tâm mã thoát. */
export function commandWorks(cmd: string, args: string[], run: CommandRunner = defaultRunner): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      run(cmd, args, (err) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        resolve(!err || (code !== 'ENOENT' && code !== 'EACCES'));
      });
    } catch {
      resolve(false);
    }
  });
}

export interface Requirements {
  node: boolean;
  player: boolean;
}

/** `player` là đường dẫn ffplay hoặc 'ffplay' để tìm trong PATH. */
export async function checkRequirements(player: string, run: CommandRunner = defaultRunner): Promise<Requirements> {
  const [node, ffplay] = await Promise.all([
    commandWorks('node', ['--version'], run),
    commandWorks(player, ['-version'], run),
  ]);
  return { node, player: ffplay };
}
