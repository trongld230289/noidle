import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_RECAP_PROMPT,
  recapInstruction,
  recapSourceLang,
  recapPromptsFor,
  needsTranslation,
  translationRequest,
  cleanTranslation,
  translateRecap,
  type RecapTranslator,
} from '../src/recapPrompt';

/**
 * Setting noIdle.recapPrompt: người dùng chỉ sửa phần "nói gì trong recap". Câu hợp đồng 🔊 (bắt đầu bằng 🔊 đầu dòng,
 * từ đó đến hết được đọc) và câu ngôn ngữ do hook tự nối, không sửa được. Người dùng viết một thứ tiếng, extension
 * dịch sang thứ tiếng còn lại bằng Copilot hay Claude của họ, không dùng API key.
 */

describe('recapInstruction', () => {
  it('default body has no speak mark: the contract is appended by the hook, not editable', () => {
    expect(DEFAULT_RECAP_PROMPT.vi).not.toContain('🔊');
    expect(DEFAULT_RECAP_PROMPT.en).not.toContain('🔊');
    expect(DEFAULT_RECAP_PROMPT.vi.length).toBeGreaterThan(100);
    expect(DEFAULT_RECAP_PROMPT.en.length).toBeGreaterThan(100);
  });

  it.each(['vi', 'en'] as const)('default body reads as a short list: one lead line, then "- " bullets (%s)', (lang) => {
    const lines = DEFAULT_RECAP_PROMPT[lang].split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0].startsWith('- ')).toBe(false);
    for (const line of lines.slice(1)) expect(line.startsWith('- ')).toBe(true);
    expect(DEFAULT_RECAP_PROMPT[lang]).toMatch(lang === 'vi' ? /3 đến 8 câu/ : /3 to 8 sentences/);
  });

  it('keeps the body on its own lines between the contract and the language line', () => {
    const lines = recapInstruction({ vi: 'Dòng một\n- Dòng hai' }, 'vi').split('\n');
    expect(lines[0]).toContain('🔊');
    expect(lines.slice(1, 3)).toEqual(['Dòng một', '- Dòng hai']);
    expect(lines[3]).toMatch(/tiếng Việt\.$/);
  });

  it('no custom prompt: default Vietnamese body wrapped with the 🔊 contract and a Vietnamese language line', () => {
    const text = recapInstruction(undefined, 'vi');
    expect(text).toContain('🔊');
    expect(text).toContain(DEFAULT_RECAP_PROMPT.vi);
    expect(text).toMatch(/tiếng Việt/);
    expect(text).not.toMatch(/English/);
  });

  it('no custom prompt, English turn: default English body, English contract and language line', () => {
    const text = recapInstruction(undefined, 'en');
    expect(text).toContain('🔊');
    expect(text).toContain(DEFAULT_RECAP_PROMPT.en);
    expect(text).toMatch(/English/);
    expect(text).not.toMatch(/tiếng Việt/);
  });

  it('custom prompt replaces the default body and still gets the contract', () => {
    const text = recapInstruction({ vi: 'Ngắn thôi.' }, 'vi');
    expect(text).toContain('Ngắn thôi.');
    expect(text).not.toContain(DEFAULT_RECAP_PROMPT.vi);
    expect(text).toContain('🔊');
  });

  it('translation not ready: uses the source text with the language line of the turn', () => {
    const text = recapInstruction({ vi: 'Ngắn thôi.' }, 'en');
    expect(text).toContain('Ngắn thôi.');
    expect(text).toMatch(/English/);
    expect(text).not.toContain(DEFAULT_RECAP_PROMPT.en);
  });

  it('translated prompt is used for the other language', () => {
    const text = recapInstruction({ vi: 'Ngắn thôi.', en: 'Keep it short.' }, 'en');
    expect(text).toContain('Keep it short.');
    expect(text).not.toContain('Ngắn thôi.');
  });
});

describe('recapSourceLang', () => {
  it('any Vietnamese diacritic means Vietnamese, otherwise English', () => {
    expect(recapSourceLang('Ngắn thôi')).toBe('vi');
    expect(recapSourceLang('Keep it short')).toBe('en');
    expect(recapSourceLang('ok')).toBe('en');
  });
});

describe('recapPromptsFor', () => {
  it('default text needs no translation: both built-in versions', () => {
    expect(needsTranslation(DEFAULT_RECAP_PROMPT.vi)).toBe(false);
    expect(recapPromptsFor(DEFAULT_RECAP_PROMPT.vi)).toEqual({ vi: DEFAULT_RECAP_PROMPT.vi, en: DEFAULT_RECAP_PROMPT.en });
  });

  it('empty text falls back to the defaults', () => {
    expect(needsTranslation('   ')).toBe(false);
    expect(recapPromptsFor('   ')).toEqual({ vi: DEFAULT_RECAP_PROMPT.vi, en: DEFAULT_RECAP_PROMPT.en });
  });

  it('custom text: source language only until translated', () => {
    expect(needsTranslation('Ngắn thôi')).toBe(true);
    expect(recapPromptsFor('Ngắn thôi')).toEqual({ vi: 'Ngắn thôi' });
    expect(recapPromptsFor('Ngắn thôi', 'Keep it short')).toEqual({ vi: 'Ngắn thôi', en: 'Keep it short' });
    expect(recapPromptsFor('Keep it short', 'Ngắn thôi')).toEqual({ vi: 'Ngắn thôi', en: 'Keep it short' });
  });
});

describe('translationRequest', () => {
  it('asks for a verbatim translation into the other language, returning only the translation', () => {
    const vi = translationRequest('Ngắn thôi.');
    expect(vi.to).toBe('en');
    expect(vi.prompt).toContain('Ngắn thôi.');
    expect(vi.prompt).toMatch(/English/);
    const en = translationRequest('Keep it short.');
    expect(en.to).toBe('vi');
    expect(en.prompt).toContain('Keep it short.');
    expect(en.prompt).toMatch(/tiếng Việt/);
  });

  it('asks the model to keep line breaks and bullets', () => {
    expect(translationRequest('Ngắn thôi.').prompt).toMatch(/line breaks/);
    expect(translationRequest('Keep it short.').prompt).toMatch(/xuống dòng/);
  });
});

describe('cleanTranslation', () => {
  it('strips code fences, quotes and whitespace the model may wrap the answer in', () => {
    expect(cleanTranslation('```\nKeep it short.\n```')).toBe('Keep it short.');
    expect(cleanTranslation('```text\nKeep it short.\n```\n')).toBe('Keep it short.');
    expect(cleanTranslation('  "Keep it short."  ')).toBe('Keep it short.');
    expect(cleanTranslation('Keep it short.')).toBe('Keep it short.');
  });
});

describe('translateRecap', () => {
  const failing: RecapTranslator = { name: 'copilot', run: async () => undefined };
  const throwing: RecapTranslator = { name: 'copilot', run: async () => { throw new Error('no model'); } };
  const working: RecapTranslator = { name: 'claude', run: async () => '```\nKeep it short.\n```' };

  it('tries backends in order and reports which one answered', async () => {
    expect(await translateRecap('Ngắn thôi.', [failing, working])).toEqual({ text: 'Keep it short.', via: 'claude' });
    expect(await translateRecap('Ngắn thôi.', [throwing, working])).toEqual({ text: 'Keep it short.', via: 'claude' });
  });

  it('returns undefined when every backend fails or answers empty', async () => {
    const empty: RecapTranslator = { name: 'claude', run: async () => '   ' };
    expect(await translateRecap('Ngắn thôi.', [failing, throwing, empty])).toBeUndefined();
    expect(await translateRecap('Ngắn thôi.', [])).toBeUndefined();
  });
});

describe('package.json', () => {
  it('ships the default Vietnamese body as the setting default so users see and edit the real text', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; editPresentation?: string }> }[] };
    };
    const props = Object.assign({}, ...pkg.contributes.configuration.map((c) => c.properties)) as Record<string, { default?: unknown; editPresentation?: string }>;
    expect(props['noIdle.recapPrompt']?.default).toBe(DEFAULT_RECAP_PROMPT.vi);
    expect(props['noIdle.recapPrompt']?.editPresentation).toBe('multilineText');
  });
});
