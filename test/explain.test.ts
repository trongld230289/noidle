import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { explainPrompt, explainSelection, captureExplainSelection, EXPLAIN_CLI_ARGS, EXPLAIN_COPILOT_ARGS, EXPLAIN_MAX_CHARS } from '../src/explain';

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

  it('says why when there is nothing selected, no CLI binary, or the CLI fails', async () => {
    const runCli = vi.fn();
    expect(await explainSelection('   ', { find: async () => 'claude', runCli })).toEqual({ ok: false, reason: 'empty' });
    expect(await explainSelection('canary', { find: async () => undefined, runCli })).toEqual({ ok: false, reason: 'no-cli' });
    expect(runCli).not.toHaveBeenCalled();
    const failing = { find: async () => 'claude', runCli: async () => { throw new Error('exit 1: Not logged in'); } };
    expect(await explainSelection('canary', failing)).toEqual({ ok: false, reason: 'exit 1: Not logged in' });
  });

  it('falls back to Copilot CLI when there is no Claude, piping the same prompt through its own flags', async () => {
    const runCli = vi.fn(async () => '  canary: bản phát hành thử.\n');
    const find = vi.fn(async (name: string) => (name === 'copilot' ? 'C:/npm/copilot.cmd' : undefined));
    const r = await explainSelection('canary', { find, runCli });
    expect(r).toEqual({ ok: true, text: 'canary: bản phát hành thử.' });
    expect(runCli).toHaveBeenCalledWith('C:/npm/copilot.cmd', EXPLAIN_COPILOT_ARGS, explainPrompt('canary'));
  });

  it('prefers Claude over Copilot when both are available', async () => {
    const runCli = vi.fn(async () => 'x');
    const find = vi.fn(async () => 'C:/npm/both.cmd');
    await explainSelection('canary', { find, runCli });
    expect(runCli).toHaveBeenCalledWith('C:/npm/both.cmd', EXPLAIN_CLI_ARGS, explainPrompt('canary'));
    expect(find).toHaveBeenCalledWith('claude');
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

  it('prompt translates to English only when the whole text is Vietnamese; mixed English/Vietnamese stays Vietnamese', () => {
    const prompt = explainPrompt('canary');
    expect(prompt).toContain('toàn bộ đoạn là tiếng Việt mới dịch sang tiếng Anh');
    expect(prompt).toContain('lẫn tiếng Anh và tiếng Việt thì vẫn trả lời bằng tiếng Việt');
  });
});

describe('explicit explanation selection', () => {
  function capture() {
    let clipboard = 'old editor clipboard';
    const deps = {
      editorSelection: vi.fn(() => 'old editor selection'),
      readClipboard: vi.fn(async () => clipboard),
      writeClipboard: vi.fn(async (text: string) => { clipboard = text; }),
      copySelection: vi.fn(async (_source: 'terminal' | 'chat') => { clipboard = 'current selection'; }),
    };
    return { deps, clipboard: () => clipboard };
  }

  it.each(['terminal', 'chat'] as const)('uses only the current %s selection, never the old editor selection', async (source) => {
    const c = capture();
    expect(await captureExplainSelection(source, c.deps)).toBe('current selection');
    expect(c.deps.editorSelection).not.toHaveBeenCalled();
    expect(c.deps.copySelection).toHaveBeenCalledWith(source);
    expect(c.clipboard()).toBe('old editor clipboard');
  });

  it('reads the clipboard directly for the clipboard source, never copying a selection', async () => {
    const c = capture();
    expect(await captureExplainSelection('clipboard', c.deps)).toBe('old editor clipboard');
    expect(c.deps.editorSelection).not.toHaveBeenCalled();
    expect(c.deps.copySelection).not.toHaveBeenCalled();
    expect(c.deps.writeClipboard).not.toHaveBeenCalled();
    expect(c.clipboard()).toBe('old editor clipboard');
  });

  it('reads the editor only when explicitly requested, without touching the clipboard', async () => {
    const c = capture();
    expect(await captureExplainSelection('editor', c.deps)).toBe('old editor selection');
    expect(c.deps.readClipboard).not.toHaveBeenCalled();
    expect(c.deps.copySelection).not.toHaveBeenCalled();
    expect(c.deps.writeClipboard).not.toHaveBeenCalled();
  });

  it.each(['terminal', 'chat'] as const)('returns empty for no %s selection instead of falling back to stale clipboard', async (source) => {
    const c = capture();
    c.deps.copySelection.mockImplementation(async () => {});
    expect(await captureExplainSelection(source, c.deps)).toBe('');
    expect(c.deps.editorSelection).not.toHaveBeenCalled();
    expect(c.clipboard()).toBe('old editor clipboard');
  });

  it('restores clipboard and reports a failed copy', async () => {
    const c = capture();
    c.deps.copySelection.mockRejectedValue(new Error('copy failed'));
    await expect(captureExplainSelection('terminal', c.deps)).rejects.toThrow('copy failed');
    expect(c.clipboard()).toBe('old editor clipboard');
  });

  it('restores clipboard even when reading the copied text fails', async () => {
    const c = capture();
    c.deps.readClipboard.mockResolvedValueOnce('saved').mockRejectedValueOnce(new Error('read failed'));
    await expect(captureExplainSelection('terminal', c.deps)).rejects.toThrow('read failed');
    expect(c.clipboard()).toBe('saved');
  });

  it('accepts a fresh selection identical to the saved clipboard', async () => {
    const c = capture();
    c.deps.copySelection.mockImplementation(async () => { await c.deps.writeClipboard('old editor clipboard'); });
    expect(await captureExplainSelection('terminal', c.deps)).toBe('old editor clipboard');
  });

  it('does not fall back to clipboard when the editor selection is empty', async () => {
    const c = capture();
    c.deps.editorSelection.mockReturnValue('');
    expect(await captureExplainSelection('editor', c.deps)).toBe('');
    expect(c.deps.readClipboard).not.toHaveBeenCalled();
  });
});

describe('explanation wiring', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const extension = readFileSync('src/extension.ts', 'utf8');

  it('places translation in its own sixth settings group without duplicating the key', () => {
    const groups = pkg.contributes.configuration.filter(
      (group: { properties: Record<string, unknown> }) => 'noIdle.translate' in group.properties,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      title: 'NoIdle 6. Dịch',
      order: 5,
      properties: { 'noIdle.translate': { type: 'boolean', default: true } },
    });
  });

  it('binds Alt+D to translate the clipboard, so a repainting terminal cannot drop the selection', () => {
    const bindings = pkg.contributes.keybindings.filter((b: { command: string }) => b.command === 'noIdle.explainSelection');
    expect(bindings).toEqual([
      { command: 'noIdle.explainSelection', key: 'alt+d', when: 'config.noIdle.translate', args: { source: 'clipboard' } },
    ]);
  });

  it('provides the translate switch with selection and shortcut guidance, gating commands and menus', () => {
    const properties = Object.assign({}, ...pkg.contributes.configuration.map((c: { properties: object }) => c.properties));
    expect(properties['noIdle.translate']).toMatchObject({ type: 'boolean', default: true });
    expect(properties['noIdle.translate'].markdownDescription).toMatch(/Alt\+D/);
    expect(properties['noIdle.translate'].markdownDescription).toMatch(/bôi/);
    expect(extension).toContain("get<boolean>('translate', true)");
    for (const menu of ['terminal/context', 'editor/context']) {
      const item = pkg.contributes.menus[menu].find((m: { command: string }) => m.command === 'noIdle.explainSelection');
      expect(item.when).toContain('config.noIdle.translate');
    }
  });

  it('removes clipboard polling and the auto-explain setting', () => {
    const properties = Object.assign({}, ...pkg.contributes.configuration.map((c: { properties: object }) => c.properties));
    expect(properties).not.toHaveProperty('noIdle.explainOnSelect');
    expect(extension).not.toMatch(/pollClipboard|clipboardTimer|autoExplainText|source === 'clipboard'/);
  });

  it('restores the old copy-on-selection override only when NoIdle owns it', () => {
    expect(extension).toContain("ctx.globalState.get<boolean>('noIdle.setCopyOnSelection')");
    expect(extension).toContain("term.update('copyOnSelection', undefined, vscode.ConfigurationTarget.Global)");
    expect(extension).not.toContain("term.update('copyOnSelection', true");
  });
});
