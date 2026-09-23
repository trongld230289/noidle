import { describe, it, expect } from 'vitest';
import { planMigration } from '../src/migrate';

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
