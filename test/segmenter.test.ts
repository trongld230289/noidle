import { describe, it, expect } from 'vitest';
import { Segmenter } from '../src/segmenter';

const RATE = 16000;
const BYTES_PER_MS = (RATE * 2) / 1000;

function pcm(ms: number, amplitude: number): Uint8Array {
  const n = Math.round((RATE * ms) / 1000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE));
  return new Uint8Array(samples.buffer);
}
const speech = (ms: number) => pcm(ms, 8000);
const silence = (ms: number) => pcm(ms, 0);
const ms = (bytes: number) => bytes / BYTES_PER_MS;

function make(opts: Partial<ConstructorParameters<typeof Segmenter>[0]> = {}) {
  const segments: Uint8Array[] = [];
  const seg = new Segmenter({ sampleRate: RATE, ...opts }, (s) => segments.push(s));
  return { seg, segments };
}

describe('Segmenter', () => {
  it('emits a segment after speech followed by 500ms of silence', () => {
    const { seg, segments } = make();
    seg.push(speech(1000));
    seg.push(silence(400));
    expect(segments).toHaveLength(0);
    seg.push(silence(200));
    expect(segments).toHaveLength(1);
    expect(ms(segments[0].byteLength)).toBeGreaterThanOrEqual(1400);
    expect(ms(segments[0].byteLength)).toBeLessThanOrEqual(1700);
  });

  it('drops long leading silence, keeping at most 200ms before speech', () => {
    const { seg, segments } = make();
    seg.push(silence(3000));
    seg.push(speech(500));
    seg.push(silence(600));
    expect(segments).toHaveLength(1);
    expect(ms(segments[0].byteLength)).toBeLessThanOrEqual(500 + 200 + 700);
  });

  it('never emits for silence only, even on flush', () => {
    const { seg, segments } = make();
    seg.push(silence(2000));
    seg.flush();
    expect(segments).toHaveLength(0);
  });

  it('splits continuous speech at maxSegmentMs', () => {
    const { seg, segments } = make({ maxSegmentMs: 3000 });
    seg.push(speech(7000));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(ms(segments[0].byteLength)).toBeCloseTo(3000, -2);
  });

  it('flush emits the trailing speech that had no silence yet', () => {
    const { seg, segments } = make();
    seg.push(speech(800));
    expect(segments).toHaveLength(0);
    seg.flush();
    expect(segments).toHaveLength(1);
    expect(ms(segments[0].byteLength)).toBeCloseTo(800, -2);
  });

  it('ignores a short click (100ms) surrounded by silence', () => {
    const { seg, segments } = make();
    seg.push(silence(500));
    seg.push(speech(100));
    seg.push(silence(1000));
    seg.flush();
    expect(segments).toHaveLength(0);
  });

  it('ignores background noise below the RMS threshold', () => {
    const { seg, segments } = make();
    seg.push(pcm(3000, 150)); // ~ -47 dBFS RMS
    seg.flush();
    expect(segments).toHaveLength(0);
  });

  it('handles chunks of arbitrary size', () => {
    const { seg, segments } = make();
    const all = new Uint8Array([...speech(1000), ...silence(700)]);
    for (let i = 0; i < all.length; i += 1000) seg.push(all.subarray(i, i + 1000));
    expect(segments).toHaveLength(1);
  });
});
