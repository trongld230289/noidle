import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { quoteWindowsArg, startProcessScript } from '../src/launch';

describe('quoteWindowsArg', () => {
  it.each([
    ['plain', 'plain'],
    ['+0%', '+0%'],
    ['', '""'],
    ['C:\\Program Files\\x.js', '"C:\\Program Files\\x.js"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\dir with space\\', '"C:\\dir with space\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['Đã xong rồi', '"Đã xong rồi"'],
  ])('%j → %j', (input, expected) => {
    expect(quoteWindowsArg(input)).toBe(expected);
  });
});

describe('startProcessScript', () => {
  it('starts the file hidden through Start-Process and prints the new pid', () => {
    expect(startProcessScript('C:\\Program Files\\nodejs\\node.exe', ["C:\\it's\\hook.js", 'play', 'C:\\Temp Dir\\say.txt'])).toBe(
      "$ErrorActionPreference = 'Stop'; " +
        "$p = Start-Process -WindowStyle Hidden -PassThru -FilePath 'C:\\Program Files\\nodejs\\node.exe' " +
        "-ArgumentList 'C:\\it''s\\hook.js play \"C:\\Temp Dir\\say.txt\"'; " +
        '[Console]::Out.Write($p.Id)',
    );
  });

  it('omits -ArgumentList when there are no arguments', () => {
    expect(startProcessScript('C:\\a.exe', [])).not.toContain('-ArgumentList');
  });

  it('escapes typographic single quotes, which PowerShell also ends strings on', () => {
    expect(startProcessScript('C:\\a.exe', ['C:\\Tho’s\\x.js'])).toContain("-ArgumentList 'C:\\Tho’’s\\x.js'");
  });
});

/**
 * VS Code chạy hook như built-in Copilot: spawn(lệnh, { shell: Windows PowerShell, stdio: 'pipe' }) và chỉ coi hook xong ở
 * sự kiện 'close'. Tiến trình nền do hook tách ra không được giữ pipe đó, không thì hook Stop kéo dài tới lúc đọc xong.
 */
describe.runIf(process.platform === 'win32')('launchDetached under the VS Code hook executor', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-launch-'));
  const bundle = path.join(work, 'fake-hook.js');
  const sleeper = path.join(work, 'sleeper.js');
  const started = path.join(work, 'started');
  const ended = path.join(work, 'ended');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let backgroundPid = 0;

  beforeAll(async () => {
    fs.writeFileSync(sleeper, `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
      setTimeout(() => fs.writeFileSync(${JSON.stringify(ended)}, 'x'), 20000);
    `);
    await build({
      stdin: {
        contents: `
          import { launchDetached } from './src/launch';
          launchDetached(process.execPath, [${JSON.stringify(sleeper)}, 'arg with space']).then((r) => process.stdout.write(JSON.stringify(r)));
        `,
        resolveDir: path.join(__dirname, '..'),
        loader: 'ts',
      },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      logLevel: 'silent',
    });
  }, 30_000);

  afterAll(() => {
    if (backgroundPid) {
      try { process.kill(backgroundPid); } catch { /* đã thoát */ }
    }
  });

  it('lets the executor finish while the background process keeps running', async () => {
    const t0 = Date.now();
    const { closeMs, stdout } = await new Promise<{ closeMs: number; stdout: string }>((resolve, reject) => {
      const child = spawn(`& ${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)}`, [], { stdio: 'pipe', shell });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.stdin.end();
      child.on('close', () => resolve({ closeMs: Date.now() - t0, stdout: out }));
    });
    const result = JSON.parse(stdout.trim()) as { pid?: number; via: string };
    expect(result.via).toBe('start-process');
    backgroundPid = result.pid ?? 0;
    for (let i = 0; i < 100 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
    expect(Number(fs.readFileSync(started, 'utf8'))).toBe(result.pid);
    // Tiến trình nền chạy 20 giây; executor phải xong trước đó rất xa và lúc xong thì nó vẫn đang chạy.
    expect(closeMs).toBeLessThan(15_000);
    expect(fs.existsSync(ended)).toBe(false);
  }, 40_000);
});
