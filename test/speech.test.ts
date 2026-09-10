import { describe, it, expect } from 'vitest';
import { lastAssistantText, pickSpeech, stripMarkdown } from '../src/speech';
import { applyHooks, hookCommands } from '../src/claudeHooks';
import { splitSentences } from '../src/speech';

const line = (o: unknown) => JSON.stringify(o);

describe('lastAssistantText', () => {
  it('returns text blocks of the last assistant entry that has text', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong.' }, { type: 'text', text: '🔊 Đã xong.' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      'garbage line',
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('Xong.\n🔊 Đã xong.');
  });
  it('returns empty when there is no assistant text', () => {
    expect(lastAssistantText('')).toBe('');
    expect(lastAssistantText(line({ type: 'user', message: { content: 'x' } }))).toBe('');
  });
});

describe('pickSpeech', () => {
  it('prefers lines marked with the speaker emoji', () => {
    const text = 'Đã sửa `src/a.ts`.\n\n```ts\nconst x = 1;\n```\n\n🔊 Xong rồi, test pass hết.\n';
    expect(pickSpeech(text)).toBe('Xong rồi, test pass hết.');
  });
  it('reads everything from the marker to the end, flattening lists', () => {
    const text = 'Bảng chi tiết ở trên.\n\n🔊 Có ba nhóm quyền:\n- Orders, **Agent** full\n- Products, Agent-only\n\nĐã xong.';
    expect(pickSpeech(text)).toBe('Có ba nhóm quyền: Orders, Agent full Products, Agent-only Đã xong.');
  });
  it('falls back to prose without code or markdown, cut at a sentence', () => {
    const long = 'Đã sửa xong. '.repeat(40);
    const text = `## Kết quả\n\n- **Sửa** hàm \`a\`\n\n\`\`\`\ncode\n\`\`\`\n\n${long}`;
    const out = pickSpeech(text);
    expect(out.startsWith('Kết quả Sửa hàm')).toBe(true);
    expect(out).not.toContain('code');
    expect(out).not.toContain('`');
    expect(out.length).toBeLessThanOrEqual(320);
    expect(out.endsWith('.')).toBe(true);
  });
  it('stripMarkdown flattens tables, links and emphasis', () => {
    expect(stripMarkdown('| a | b |\n|---|---|\nxem [tài liệu](http://x) *ngay* __đi__')).toBe('xem tài liệu ngay đi');
  });
});

describe('applyHooks', () => {
  const opts = { enabled: true, script: 'C:\\ext\\trongld.vi-voice-1.2.0\\dist\\claude-hook.js', voice: 'vi-VN-HoaiMyNeural', rate: '+0%', player: 'ffplay' };

  it('adds Stop and UserPromptSubmit hooks and keeps existing hooks', () => {
    const settings = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }] } };
    const out = applyHooks(settings, opts);
    expect(out.model).toBe('x');
    expect(out.hooks!.Stop).toHaveLength(2);
    expect(out.hooks!.Stop[0].hooks![0].command).toBe('node other.js');
    expect(out.hooks!.Stop[1].hooks![0].command).toBe(hookCommands(opts).Stop);
    expect(out.hooks!.UserPromptSubmit[0].hooks![0].command).toBe(hookCommands(opts).UserPromptSubmit);
    expect(hookCommands(opts).Stop).toContain('"C:/ext/trongld.vi-voice-1.2.0/dist/claude-hook.js" speak --voice vi-VN-HoaiMyNeural');
  });

  it('replaces an older Vi Voice hook instead of duplicating it', () => {
    const once = applyHooks({}, { ...opts, script: 'C:/old/trongld.vi-voice-1.1.0/dist/claude-hook.js' });
    const twice = applyHooks(once, opts);
    expect(twice.hooks!.Stop).toHaveLength(1);
    expect(twice.hooks!.Stop[0].hooks![0].command).toContain('1.2.0');
  });

  it('removes Vi Voice hooks when disabled and drops empty hook maps', () => {
    const on = applyHooks({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node keep.js' }] }] } }, opts);
    const off = applyHooks(on, { ...opts, enabled: false });
    expect(off.hooks).toEqual({ PostToolUse: [{ hooks: [{ type: 'command', command: 'node keep.js' }] }] });
    expect(applyHooks(applyHooks({}, opts), { ...opts, enabled: false })).toEqual({});
  });
});

describe('splitSentences', () => {
  it('groups two sentences per chunk and respects the char limit', () => {
    const text = 'Một. Hai. Ba. Bốn dài ' + 'x'.repeat(230) + '. Năm.';
    expect(splitSentences(text)).toEqual(['Một. Hai.', 'Ba.', 'Bốn dài ' + 'x'.repeat(230) + '.', 'Năm.']);
  });
  it('returns a single chunk for short text', () => {
    expect(splitSentences('  Xong rồi,  test pass. ')).toEqual(['Xong rồi, test pass.']);
  });
});
