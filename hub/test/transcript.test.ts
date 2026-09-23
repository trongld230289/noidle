import { describe, it, expect } from 'vitest';
import { lastAssistantText, pickSpeech, stripMarkdown, workspaceName } from '../src/transcript';

const line = (o: unknown) => JSON.stringify(o);

describe('lastAssistantText', () => {
  it('returns the text of the last assistant entry, string or blocks, skipping tool-only entries', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      line({ type: 'assistant', message: { content: 'last one' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      'not json',
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('last one');
  });
  it('joins several text blocks and returns empty when nothing found', () => {
    expect(lastAssistantText(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }))).toBe('a\nb');
    expect(lastAssistantText('')).toBe('');
  });
});

describe('pickSpeech', () => {
  it('takes everything from the first 🔊 line to the end, markdown stripped', () => {
    const text = 'Đã sửa xong.\n\n```ts\nconst a = 1;\n```\n\n🔊 Xong rồi, **đã sửa** hai file.\nCòn một việc:\n- chạy test\n- commit';
    expect(pickSpeech(text)).toBe('Xong rồi, đã sửa hai file. Còn một việc: chạy test commit');
  });
  it('falls back to the first ~300 characters of prose cut at a sentence', () => {
    const long = 'Câu một khá dài để thử. '.repeat(20);
    const out = pickSpeech(`# Tiêu đề\n${long}`);
    expect(out.length).toBeLessThanOrEqual(320);
    expect(out.endsWith('.')).toBe(true);
    expect(out.startsWith('Tiêu đề Câu một')).toBe(true);
  });
});

describe('stripMarkdown', () => {
  it('removes code, headings, bullets, emphasis, links and tables', () => {
    expect(stripMarkdown('## Hi\n`x` and [link](http://a) **bold** *it*\n| a | b |\n- one')).toBe('Hi and link bold it one');
  });
});

describe('workspaceName', () => {
  it('uses the last folder, replaces separators, falls back to unnamed', () => {
    expect(workspaceName('D:\\Project\\vi-voice')).toBe('vi voice');
    expect(workspaceName('/home/u/SHIPNGO-BE/')).toBe('SHIPNGO BE');
    expect(workspaceName('')).toBe('unnamed');
  });
});
