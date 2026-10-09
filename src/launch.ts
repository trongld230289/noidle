/**
 * Tách tiến trình chạy nền (play đọc giọng) sao cho agent không phải chờ nó.
 *
 * Windows: VS Code chạy hook qua `powershell -c` và chỉ coi hook xong khi pipe stdout/stderr đóng ('close'). PowerShell
 * cho node kế thừa luôn handle pipe của trình chạy hook; node chỉ tắt kế thừa cho handle stdio của chính nó, nên tiến
 * trình con tách bằng spawn (kể cả detached, stdio 'ignore') vẫn giữ pipe đó tới khi đọc xong. Hook Stop từng kéo 47 đến
 * 93 giây (log Copilot Chat Hooks 9/10/2026), quá timeout 60 giây. Start-Process tạo tiến trình bằng ShellExecuteEx,
 * không kế thừa handle nào, nên hook xong ngay khi PowerShell thoát. PowerShell không được detached: tách rời thì
 * Windows PowerShell không chạy lệnh nào cả.
 */
import { spawn } from 'child_process';

export interface LaunchResult {
  pid?: number;
  via: 'start-process' | 'spawn';
  /** Có khi Start-Process không dùng được và đã tách trực tiếp (hook sẽ phải chờ tiến trình đó như trước). */
  error?: string;
}

/** Một đối số dòng lệnh Windows theo quy tắc CommandLineToArgvW (như quote_cmd_arg của libuv). */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    out += ch === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** Chuỗi PowerShell trong nháy đơn; PowerShell cũng kết thúc chuỗi ở các dấu nháy cong nên nhân đôi cả chúng. */
function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c)}'`;
}

/** Lệnh PowerShell một dòng: Start-Process ẩn cửa sổ rồi in pid tiến trình mới. */
export function startProcessScript(file: string, args: string[]): string {
  const argLine = args.map(quoteWindowsArg).join(' ');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -WindowStyle Hidden -PassThru -FilePath ${psQuote(file)}${argLine ? ` -ArgumentList ${psQuote(argLine)}` : ''}`,
    '[Console]::Out.Write($p.Id)',
  ].join('; ');
}

function spawnDetached(file: string, args: string[], error?: string): LaunchResult {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
  return { pid: child.pid, via: 'spawn', ...(error ? { error } : {}) };
}

/**
 * Chạy file như một tiến trình nền độc lập. Windows: qua Start-Process, resolve khi PowerShell đã thoát (tiến trình
 * hook còn sống tới lúc đó vì đang chờ tiến trình con); lỗi thì tách trực tiếp như trước. Nơi khác: spawn detached.
 */
export function launchDetached(file: string, args: string[], platform: NodeJS.Platform = process.platform): Promise<LaunchResult> {
  if (platform !== 'win32') return Promise.resolve(spawnDetached(file, args));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: LaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let out = '';
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', startProcessScript(file, args)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    // PowerShell treo (máy quá tải): bỏ nó, tách trực tiếp để vẫn có tiếng.
    const timer = setTimeout(() => {
      ps.kill();
      finish(spawnDetached(file, args, 'Start-Process quá 15 giây'));
    }, 15_000);
    ps.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    ps.on('error', (err) => finish(spawnDetached(file, args, err.message)));
    ps.on('close', (code) => {
      const pid = Number(out.trim());
      if (code === 0 && Number.isSafeInteger(pid) && pid > 0) finish({ pid, via: 'start-process' });
      else finish(spawnDetached(file, args, `Start-Process thoát ${code}`));
    });
  });
}
