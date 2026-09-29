import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';

/** Hook thật chạy với config language: "en": prompt, speak và notify đều bằng tiếng Anh. Cùng cách dựng như hook.test.ts. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-hook-en-test-'));
const bundle = path.join(work, 'claude-hook.js');
const cfgEn = path.join(work, 'en.json');
const logFile = path.join(work, 'tmp', 'noidle-tts', 'hook.log');
const noPlayer = path.join(work, 'no-such-player.exe');

function run(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(work, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

beforeAll(async () => {
  await build({
    entryPoints: [path.join(__dirname, '..', 'src', 'hook.ts')],
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'silent',
  });
  // Lần chạy đầu của bundle mới trên Windows chậm vài giây (Defender quét file): làm nóng ở đây để test đầu không timeout.
  await run(['skip'], '');
  fs.writeFileSync(cfgEn, JSON.stringify({ language: 'en', pronunciations: { acme: 'acme shop' } }));
}, 30_000);

describe('hook in English mode', () => {
  it('prompt: inserts the English instructions', async () => {
    const r = await run(['prompt', '--config', cfgEn], JSON.stringify({ session_id: 'en-1', cwd: work }));
    expect(r.code).toBe(0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/English/);
    expect(ctx).not.toMatch(/tiếng Việt/);
  });

  it('speak: skips the Vietnamese pronunciation table but keeps the user table', async () => {
    const transcript = path.join(work, 'transcript-en.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '🔊 Done, acme now reads README.md and calls the API.' }] } }) + '\n',
    );
    const before = readLog().length;
    const r = await run(['speak', '--config', cfgEn, '--player', noPlayer], JSON.stringify({ session_id: 'en-2', cwd: work, transcript_path: transcript }));
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toContain('Done, acme shop now reads README.md and calls the API.');
  });

  it('notify: announces in English', async () => {
    const before = readLog().length;
    const r = await run(
      ['notify', '--config', cfgEn, '--player', noPlayer],
      JSON.stringify({ session_id: 'en-3', hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: path.join(work, 'shop') }),
    );
    expect(r.code).toBe(0);
    expect(readLog().slice(before)).toContain('Workspace shop needs approval.');
  });
});
