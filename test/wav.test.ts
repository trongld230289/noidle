import { describe, it, expect } from 'vitest';
import { pcmToWav, audioLevel } from '../src/wav';

describe('pcmToWav', () => {
  it('prepends a 44-byte RIFF header for 16kHz mono s16le', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = pcmToWav(pcm, 16000, 1);
    expect(wav.length).toBe(44 + 4);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 4);
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(String.fromCharCode(...wav.subarray(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4]);
  });
});

describe('audioLevel', () => {
  it('reports -inf for silence and 0 dB peak for full scale', () => {
    const silence = pcmToWav(new Uint8Array(400), 16000, 1);
    expect(audioLevel(silence).peakDb).toBe(-Infinity);
    const pcm = new Int16Array([32767, -32768, 0, 0]);
    const loud = pcmToWav(new Uint8Array(pcm.buffer), 16000, 1);
    expect(audioLevel(loud).peakDb).toBeCloseTo(0, 1);
  });
  it('half scale peak is about -6 dB', () => {
    const pcm = new Int16Array([16384, -16384]);
    const wav = pcmToWav(new Uint8Array(pcm.buffer), 16000, 1);
    expect(audioLevel(wav).peakDb).toBeCloseTo(-6.02, 1);
  });
});
