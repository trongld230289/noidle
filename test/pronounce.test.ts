import { describe, it, expect } from 'vitest';
import { pronounce, DEFAULT_PRONUNCIATIONS } from '../src/pronounce';

describe('pronounce', () => {
  it('spells file extensions with English letter names in Vietnamese syllables', () => {
    expect(pronounce('cần đọc file README.md trước khi làm')).toBe('cần đọc file README chấm em đi trước khi làm');
    expect(pronounce('sửa src/segmenter.ts và tsconfig.json')).toBe('sửa src/segmenter chấm ti ét và tsconfig chấm chây sơn');
  });

  it('replaces acronyms as whole words regardless of case', () => {
    expect(pronounce('gọi API rồi trả JSON về UI')).toBe('gọi ây pi ai rồi trả chây sơn về diu ai');
    expect(pronounce('mở api')).toBe('mở ây pi ai');
  });

  it('leaves letters inside other words and Vietnamese words alone', () => {
    expect(pronounce('rapid ủi quần')).toBe('rapid ủi quần');
    expect(pronounce('MDX')).toBe('MDX');
  });

  it('handles keys containing punctuation such as CI/CD and VS Code', () => {
    expect(pronounce('chạy CI/CD trong VS Code')).toBe('chạy xi ai xi đi trong vi ét cốt');
  });

  it('lets user entries add words and override defaults', () => {
    const extra = { API: 'a pê i', shipngo: 'síp gô' };
    expect(pronounce('shipngo gọi API', extra)).toBe('síp gô gọi a pê i');
  });

  it('ignores blank keys, and an empty value disables that default so the word is read as written', () => {
    expect(pronounce('gọi API và JSON', { '': 'x', '  ': 'y', API: '' })).toBe('gọi API và chây sơn');
  });

  it('covers common git and dev words, BE/FE, IP versions and vendor names', () => {
    expect(pronounce('merge master về, commit rồi push, stash appsettings')).toBe(
      'mợt mát tơ về, com mít rồi pút, sờ tát áp sét ting',
    );
    expect(pronounce('BE trả null cho FE, IPv6 reset nên ép IPv4')).toBe('bi i trả nâu cho ép i, ip vê six reset nên ép ai pi vê four');
    expect(pronounce('Azure DevOps và FedEx')).toBe('a giơ đép óp và phét ếch');
    expect(pronounce('SSH key hết hạn, mở popup invoice và dialog pronunciations')).toBe(
      'ét ét ách ki hết hạn, mở póp úp ình voi và đai lóc prô nân xi ây sừn',
    );
  });

  it('ships defaults for common extensions and acronyms', () => {
    expect(DEFAULT_PRONUNCIATIONS['.md']).toBe('chấm em đi');
    expect(DEFAULT_PRONUNCIATIONS['API']).toBe('ây pi ai');
    expect(pronounce('Claude và Gemini')).toBe('cờ lốt và giê mi nai');
  });
});
