export interface SegmenterOptions {
  sampleRate: number;
  /** Im lặng liên tục bao lâu (ms) sau khi có tiếng nói thì cắt cụm. */
  silenceMs?: number;
  /** Cụm dài tối đa (ms) rồi cắt dù chưa ngắt hơi. */
  maxSegmentMs?: number;
  /** Giữ lại tối đa bao nhiêu ms im lặng trước khi tiếng nói bắt đầu. */
  leadInMs?: number;
  /** Khung phân tích (ms). */
  frameMs?: number;
  /** RMS của khung dưới mức này (dBFS) coi là im lặng. */
  speechThresholdDb?: number;
  /** Tổng thời gian khung có tiếng nói tối thiểu (ms) để cụm được gửi; ngắn hơn coi là tiếng động. */
  minSpeechMs?: number;
}

/**
 * Cắt luồng PCM s16le mono thành các cụm tiếng nói dựa trên ngắt hơi.
 * push() nhận chunk kích thước bất kỳ; onSegment được gọi với PCM của mỗi cụm.
 */
export class Segmenter {
  private readonly silenceMs: number;
  private readonly maxSegmentMs: number;
  private readonly leadInMs: number;
  private readonly frameBytes: number;
  private readonly bytesPerMs: number;
  private readonly threshold: number;
  private readonly minSpeechMs: number;
  private speechMs = 0;

  private pending: Uint8Array = new Uint8Array(0); // bytes chưa đủ một khung
  private frames: Uint8Array[] = []; // các khung của cụm hiện tại
  private hasSpeech = false;
  private silenceRunMs = 0;
  private segmentMs = 0;

  constructor(opts: SegmenterOptions, private readonly onSegment: (pcm: Uint8Array) => void) {
    const frameMs = opts.frameMs ?? 100;
    this.silenceMs = opts.silenceMs ?? 500;
    this.maxSegmentMs = opts.maxSegmentMs ?? 10_000;
    this.leadInMs = opts.leadInMs ?? 200;
    this.bytesPerMs = (opts.sampleRate * 2) / 1000;
    this.frameBytes = Math.round(this.bytesPerMs * frameMs);
    this.threshold = 32768 * Math.pow(10, (opts.speechThresholdDb ?? -42) / 20);
    this.minSpeechMs = opts.minSpeechMs ?? 300;
  }

  push(chunk: Uint8Array): void {
    let data = this.pending.length ? concat([this.pending, chunk]) : chunk;
    while (data.length >= this.frameBytes) {
      this.frame(data.subarray(0, this.frameBytes));
      data = data.subarray(this.frameBytes);
    }
    this.pending = data.slice();
  }

  /** Cắt nốt cụm đang dở (kể cả phần chưa đủ khung). */
  flush(): void {
    if (this.pending.length) {
      this.frame(this.pending);
      this.pending = new Uint8Array(0);
    }
    this.emit();
  }

  private frame(f: Uint8Array): void {
    const frameMs = f.length / this.bytesPerMs;
    const loud = rms(f) >= this.threshold;
    if (loud) {
      this.hasSpeech = true;
      this.speechMs += frameMs;
      this.silenceRunMs = 0;
    } else {
      this.silenceRunMs += frameMs;
    }
    this.frames.push(f);
    this.segmentMs += frameMs;

    if (!this.hasSpeech) {
      // Chưa có tiếng nói: chỉ giữ lại leadInMs cuối.
      while (this.segmentMs > this.leadInMs && this.frames.length > 1) {
        this.segmentMs -= this.frames[0].length / this.bytesPerMs;
        this.frames.shift();
      }
      return;
    }
    if (this.silenceRunMs >= this.silenceMs || this.segmentMs >= this.maxSegmentMs) this.emit();
  }

  private emit(): void {
    const frames = this.frames;
    const enough = this.hasSpeech && this.speechMs >= this.minSpeechMs;
    this.frames = [];
    this.hasSpeech = false;
    this.speechMs = 0;
    this.silenceRunMs = 0;
    this.segmentMs = 0;
    if (enough && frames.length) this.onSegment(concat(frames));
  }
}

function rms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    const s = view.getInt16(i, true);
    sumSq += s * s;
    n++;
  }
  return n ? Math.sqrt(sumSq / n) : 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
