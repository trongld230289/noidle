import { expect, test } from 'vitest';
import { fullVoiceName, secMsGecV2 } from '../src/edgeToken';

// python edge-tts 7.3.1 in ra: generate_sec_ms_gec_v2(t).
test('token v2 khớp edge-tts 7.3.1', () => {
  expect(secMsGecV2(0)).toBe('52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6');
  expect(secMsGecV2(1700000000)).toBe('2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2');
  expect(secMsGecV2(1761273600.5)).toBe('A8A7095E7AC3927E-F004B73D066552098A3C059B13DA81C57A9D993BF98FE41DEB0CA1FCE058B32F');
  expect(secMsGecV2(1793000000)).toBe('781C1B76C9F739B3-1A772624F17530DF13FBF300637917F70D55C163861ADEC2DA70A248A0DE438A');
});

test('tên giọng ngắn thành tên đầy đủ Edge gửi', () => {
  expect(fullVoiceName('vi-VN-HoaiMyNeural')).toBe('Microsoft Server Speech Text to Speech Voice (vi-VN, HoaiMyNeural)');
  expect(fullVoiceName('en-US-BrianMultilingualNeural')).toBe('Microsoft Server Speech Text to Speech Voice (en-US, BrianMultilingualNeural)');
});
