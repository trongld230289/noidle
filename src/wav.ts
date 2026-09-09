/** Bọc PCM s16le thành file WAV (header 44 byte). */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Mức âm của WAV s16le: peak và RMS tính theo dBFS (0 = cực đại, -Infinity = im lặng). */
export function audioLevel(wav: Uint8Array): { peakDb: number; rmsDb: number } {
  const view = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
  const n = Math.floor(view.byteLength / 2);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x / 32768) : -Infinity);
  return { peakDb: toDb(peak), rmsDb: n > 0 ? toDb(Math.sqrt(sumSq / n)) : -Infinity };
}
