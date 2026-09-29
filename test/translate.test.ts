import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { claudeCliTranslator, runCli, CLAUDE_CLI_ARGS } from '../src/translate';

/** Dịch recapPrompt bằng Claude Code CLI của người dùng: `claude -p --output-format text`, prompt đưa qua stdin. */
describe('claudeCliTranslator', () => {
  it('is unavailable when the claude binary is not installed', async () => {
    const runCli = vi.fn();
    const t = claudeCliTranslator({ find: async () => undefined, runCli });
    expect(t.name).toBe('claude');
    expect(await t.run('Translate this')).toBeUndefined();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('pipes the prompt through claude -p and returns its output', async () => {
    const runCli = vi.fn(async () => 'Keep it short.\n');
    const t = claudeCliTranslator({ find: async (name: string) => (name === 'claude' ? 'C:/npm/claude.cmd' : undefined), runCli });
    expect(await t.run('Translate this')).toBe('Keep it short.\n');
    expect(runCli).toHaveBeenCalledWith('C:/npm/claude.cmd', CLAUDE_CLI_ARGS, 'Translate this');
  });

  it('returns undefined when the CLI fails', async () => {
    const t = claudeCliTranslator({ find: async () => 'C:/npm/claude.cmd', runCli: async () => { throw new Error('exit 1'); } });
    expect(await t.run('Translate this')).toBeUndefined();
  });
});

describe('runCli', () => {
  it('marks the child as internal (NOIDLE_INTERNAL=1) and runs it outside the project so user hooks stay quiet', async () => {
    const script = 'process.stdout.write(process.env.NOIDLE_INTERNAL + "|" + process.cwd() + "|" + require("fs").readFileSync(0, "utf8"))';
    const out = await runCli(process.execPath, ['-e', script], 'stdin text');
    const [internal, cwd, input] = out.split('|');
    expect(internal).toBe('1');
    expect(path.resolve(cwd)).toBe(path.resolve(os.tmpdir()));
    expect(input).toBe('stdin text');
  });

  it('rejects when the child exits with an error', async () => {
    await expect(runCli(process.execPath, ['-e', 'process.exit(3)'], '')).rejects.toThrow(/exit 3/);
  });
});
