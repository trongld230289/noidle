import { describe, it, expect } from 'vitest';
import { parseAudioDevices } from '../src/devices';

const sample = `
[in#0 @ 000001d9bc208a00] "OV01A" (video)
[in#0 @ 000001d9bc208a00]   Alternative name "@device_pnp_\\\\?\\usb#vid_0000"
[in#0 @ 000001d9bc208a00] "Microphone Array (2- Intel® Smart Sound Technology for MIPI SoundWire® Audio)" (audio)
[in#0 @ 000001d9bc208a00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{BFB5EAB3}"
[in#0 @ 000001d9bc208a00] "Headset Mic (USB)" (audio)
dummy: Immediate exit requested
`;

describe('parseAudioDevices', () => {
  it('returns friendly names of audio devices only, in order', () => {
    expect(parseAudioDevices(sample)).toEqual([
      'Microphone Array (2- Intel® Smart Sound Technology for MIPI SoundWire® Audio)',
      'Headset Mic (USB)',
    ]);
  });
  it('returns empty list when no audio device', () => {
    expect(parseAudioDevices('[in#0] "Cam" (video)\n')).toEqual([]);
  });
});
