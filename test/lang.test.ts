import { describe, it, expect } from 'vitest';
import { langOf, effectiveVoice, detectLang, isAuto } from '../src/lang';

describe('langOf', () => {
  it('maps the noIdle.language setting to vi or en', () => {
    expect(langOf('vi')).toBe('vi');
    expect(langOf('en')).toBe('en');
    expect(langOf('en-US')).toBe('en');
    expect(langOf('EN')).toBe('en');
    // Whisper verbose_json trả tên đầy đủ.
    expect(langOf('english')).toBe('en');
    expect(langOf('vietnamese')).toBe('vi');
  });
  it('defaults to vi for empty (Whisper auto-detect), auto or unknown values', () => {
    expect(langOf('')).toBe('vi');
    expect(langOf(undefined)).toBe('vi');
    expect(langOf('ja')).toBe('vi');
    expect(langOf('auto')).toBe('vi');
  });
});

describe('isAuto', () => {
  it('recognises the auto setting only', () => {
    expect(isAuto('auto')).toBe(true);
    expect(isAuto('Auto ')).toBe(true);
    expect(isAuto('vi')).toBe(false);
    expect(isAuto('')).toBe(false);
    expect(isAuto(undefined)).toBe(false);
  });
});

describe('detectLang', () => {
  it('sees Vietnamese from diacritics or common unaccented words', () => {
    expect(detectLang('sửa lỗi này giúp mình')).toBe('vi');
    expect(detectLang('lam auto di, khong can hoi')).toBe('vi');
    expect(detectLang('refactor claimNext nha')).toBe('vi');
    expect(detectLang('Đọc README')).toBe('vi');
  });
  it('sees English from plain ASCII sentences', () => {
    expect(detectLang('please refactor the claimNext function and run the tests')).toBe('en');
    expect(detectLang('why does the build fail?')).toBe('en');
  });
  it('returns undefined when too short or ambiguous', () => {
    expect(detectLang('ok')).toBeUndefined();
    expect(detectLang('yes')).toBeUndefined();
    expect(detectLang('')).toBeUndefined();
    expect(detectLang('   ')).toBeUndefined();
    expect(detectLang('git push')).toBeUndefined();
  });
});

describe('effectiveVoice', () => {
  it('swaps a Vietnamese-only voice for a multilingual one when speaking English', () => {
    expect(effectiveVoice('vi-VN-HoaiMyNeural', 'en')).toBe('en-US-AvaMultilingualNeural');
    expect(effectiveVoice('vi-VN-NamMinhNeural', 'en')).toBe('en-US-AvaMultilingualNeural');
  });
  it('keeps the chosen voice otherwise', () => {
    expect(effectiveVoice('en-US-BrianMultilingualNeural', 'en')).toBe('en-US-BrianMultilingualNeural');
    expect(effectiveVoice('vi-VN-HoaiMyNeural', 'vi')).toBe('vi-VN-HoaiMyNeural');
    expect(effectiveVoice('en-US-AvaMultilingualNeural', 'vi')).toBe('en-US-AvaMultilingualNeural');
  });
});
