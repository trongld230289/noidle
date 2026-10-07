import { describe, it, expect, vi } from 'vitest';
import { explainPrompt, explainSelection, EXPLAIN_CLI_ARGS, EXPLAIN_MAX_CHARS } from '../src/explain';

/** Quét chữ rồi bấm phím tắt: Haiku qua Claude Code CLI có sẵn giải nghĩa đoạn đó. */
describe('explainSelection', () => {
  it('runs the cheapest model without user plugins, hooks or MCP servers (39s → 8s measured 8/10/2026)', () => {
    expect(EXPLAIN_CLI_ARGS).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--strict-mcp-config', '--setting-sources', 'project']));
  });

  it('pipes the prompt with the selection through claude and returns the trimmed answer', async () => {
    const runCli = vi.fn(async () => '  canary: bản phát hành thử cho một nhóm nhỏ.\n');
    const r = await explainSelection('canary', { find: async () => 'C:/npm/claude.cmd', runCli });
    expect(r).toEqual({ ok: true, text: 'canary: bản phát hành thử cho một nhóm nhỏ.' });
    expect(runCli).toHaveBeenCalledWith('C:/npm/claude.cmd', EXPLAIN_CLI_ARGS, explainPrompt('canary'));
  });

  it('says why when there is nothing selected, no claude binary, or the CLI fails', async () => {
    const runCli = vi.fn();
    expect(await explainSelection('   ', { find: async () => 'claude', runCli })).toEqual({ ok: false, reason: 'empty' });
    expect(await explainSelection('canary', { find: async () => undefined, runCli })).toEqual({ ok: false, reason: 'no-claude' });
    expect(runCli).not.toHaveBeenCalled();
    const failing = { find: async () => 'claude', runCli: async () => { throw new Error('exit 1: Not logged in'); } };
    expect(await explainSelection('canary', failing)).toEqual({ ok: false, reason: 'exit 1: Not logged in' });
  });

  it('cuts a huge selection so one stray drag does not send a whole screen of log', () => {
    const prompt = explainPrompt('x'.repeat(EXPLAIN_MAX_CHARS + 500));
    expect(prompt).toContain('x'.repeat(EXPLAIN_MAX_CHARS));
    expect(prompt).not.toContain('x'.repeat(EXPLAIN_MAX_CHARS + 1));
  });

  it('prompt asks for a short Vietnamese explanation in a programming context, English when the text is already Vietnamese', () => {
    const prompt = explainPrompt('canary');
    expect(prompt).toContain('tiếng Việt');
    expect(prompt).toContain('lập trình');
    expect(prompt).toContain('tiếng Anh');
    expect(prompt).toContain('canary');
  });
});
