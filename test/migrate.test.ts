import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { planMigration, planMuteMigration, configProperties } from '../src/migrate';

/**
 * Đổi tên 1.x → 2.0: id setting viVoice.* thành noIdle.*. Lần đầu chạy bản mới, giá trị người dùng đã đặt
 * (API key, bảng phát âm, giọng...) phải được chép sang id mới rồi xoá id cũ, không đụng giá trị mới đã có.
 */
describe('planMigration', () => {
  const keys = ['groqApiKey', 'voice', 'pronunciations', 'handsFree'];
  it('copies every old value whose new key is still unset, and clears the old key', () => {
    const old = { groqApiKey: 'gsk_1', voice: 'en-US-BrianMultilingualNeural', pronunciations: { API: '' } };
    const plan = planMigration(keys, (k) => old[k as keyof typeof old], () => undefined);
    expect(plan.set).toEqual([
      ['groqApiKey', 'gsk_1'],
      ['voice', 'en-US-BrianMultilingualNeural'],
      ['pronunciations', { API: '' }],
    ]);
    expect(plan.clear).toEqual(['groqApiKey', 'voice', 'pronunciations']);
  });
  it('keeps a value already set under the new id, but still clears the old one', () => {
    const plan = planMigration(['voice'], () => 'old-voice', () => 'new-voice');
    expect(plan.set).toEqual([]);
    expect(plan.clear).toEqual(['voice']);
  });
  it('does nothing when there are no old values', () => {
    const plan = planMigration(keys, () => undefined, () => undefined);
    expect(plan.set).toEqual([]);
    expect(plan.clear).toEqual([]);
  });
});

describe('configProperties', () => {
  it('đọc được cả dạng một khối và dạng nhiều nhóm có tiêu đề', () => {
    expect(Object.keys(configProperties({ configuration: { properties: { 'noIdle.a': {} } } }))).toEqual(['noIdle.a']);
    expect(Object.keys(configProperties({ configuration: [{ title: 'A', properties: { 'noIdle.a': {} } }, { title: 'B', properties: { 'noIdle.b': {} } }] }))).toEqual(['noIdle.a', 'noIdle.b']);
    expect(configProperties(undefined)).toEqual({});
  });
});

describe('planMuteMigration', () => {
  it('voiceMute bật thì chuyển thành voiceResponse tắt, rồi xoá voiceMute', () => {
    expect(planMuteMigration(true)).toEqual({ voiceResponse: false, clearMute: true });
  });
  it('voiceMute tắt thì chỉ xoá, không đụng voiceResponse', () => {
    expect(planMuteMigration(false)).toEqual({ clearMute: true });
  });
  it('chưa từng đặt voiceMute thì không làm gì', () => {
    expect(planMuteMigration(undefined)).toEqual({ clearMute: false });
  });
});

describe('package.json: voiceMute bỏ khỏi nhóm 1, chỉ còn là setting cũ tự chuyển', () => {
  it('noIdle.voiceMute chỉ còn khai báo deprecated', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const blocks = pkg.contributes.configuration as { title: string; properties: Record<string, { deprecationMessage?: string }> }[];
    const group1 = blocks.find((b) => b.title.startsWith('NoIdle 1.'))!;
    expect(Object.keys(group1.properties)).not.toContain('noIdle.voiceMute');
    const all = Object.assign({}, ...blocks.map((b) => b.properties));
    expect(all['noIdle.voiceMute']?.deprecationMessage).toMatch(/voiceResponse/);
  });
});
