import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listenOnce, type ListenDeps } from '../src/listen';

/**
 * Bíp rồi mới mở mic là mất câu: ffmpeg lạnh mất ~2s mới đẩy dữ liệu, người dùng nói "approve" ngay sau bíp
 * thì mic chưa thu. Luồng đúng: mở mic, chờ dữ liệu chảy, bíp, bỏ đuôi bíp, rồi mới nghe.
 */
function fake(opts: { startMs?: number; beepMs?: number; startError?: Error } = {}) {
  const events: string[] = [];
  let onData: ((chunk: Uint8Array) => void) | undefined;
  const pushed: Uint8Array[] = [];
  let emit: ((pcm: Uint8Array) => void) | undefined;
  let cancel: (() => void) | undefined;
  const deps: ListenDeps = {
    start: (cb) =>
      new Promise((resolve, reject) => {
        events.push('start');
        setTimeout(() => {
          if (opts.startError) return reject(opts.startError);
          onData = cb;
          events.push('mic-live');
          resolve();
        }, opts.startMs ?? 2000);
      }),
    beep: () =>
      new Promise((resolve) => {
        events.push('beep');
        setTimeout(() => {
          events.push('beep-done');
          resolve();
        }, opts.beepMs ?? 400);
      }),
    segmenter: (onSegment) => {
      emit = onSegment;
      return { push: (c) => pushed.push(c) };
    },
    onCancel: (c) => (cancel = c),
    timeoutMs: 3000,
    guardMs: 200,
  };
  return {
    deps,
    events,
    pushed,
    mic: (chunk = new Uint8Array(320)) => onData?.(chunk),
    emit: (pcm = new Uint8Array(1600)) => emit?.(pcm),
    cancel: () => cancel?.(),
  };
}

describe('listenOnce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not beep until the mic is actually delivering audio', async () => {
    const f = fake({ startMs: 2000 });
    const p = listenOnce(f.deps);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.events).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events).toEqual(['start', 'mic-live', 'beep']);
    f.cancel();
    await p;
  });

  it('drops audio captured during the beep and the guard after it, keeps what comes next', async () => {
    const f = fake({ startMs: 100, beepMs: 400 });
    const p = listenOnce(f.deps);
    await vi.advanceTimersByTimeAsync(100);
    f.mic(); // tiếng loa lúc đang bíp
    await vi.advanceTimersByTimeAsync(400);
    f.mic(); // đuôi bíp
    await vi.advanceTimersByTimeAsync(199);
    f.mic(); // vẫn trong guard
    expect(f.pushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const chunk = new Uint8Array([1, 2, 3, 4]);
    f.mic(chunk);
    expect(f.pushed).toEqual([chunk]);
    const pcm = new Uint8Array([9, 9]);
    f.emit(pcm);
    await expect(p).resolves.toBe(pcm);
  });

  it('counts the timeout from after the beep, not from when the mic started opening', async () => {
    const f = fake({ startMs: 2000, beepMs: 400 });
    let result: Uint8Array | undefined | 'pending' = 'pending';
    const p = listenOnce(f.deps).then((r) => (result = r));
    // start 2000 + beep 400 + guard 200 + timeout 3000 = 5600
    await vi.advanceTimersByTimeAsync(5599);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(result).toBeUndefined();
  });

  it('cancelled while the mic is still opening: waits for the mic, never beeps, resolves undefined', async () => {
    const f = fake({ startMs: 2000 });
    let result: Uint8Array | undefined | 'pending' = 'pending';
    const p = listenOnce(f.deps).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(500);
    f.cancel();
    // Chưa trả ngay: bên gọi cần start xong để stop() được thật (xem listen.ts).
    await vi.advanceTimersByTimeAsync(1499);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.events).not.toContain('beep');
  });

  it('cancelled after the beep: resolves undefined right away', async () => {
    const f = fake({ startMs: 100, beepMs: 100 });
    const p = listenOnce(f.deps);
    await vi.advanceTimersByTimeAsync(500);
    f.cancel();
    await expect(p).resolves.toBeUndefined();
  });

  it('mic fails to open: no beep, resolves undefined and reports the error', async () => {
    const log: string[] = [];
    const f = fake({ startMs: 50, startError: new Error('ffmpeg không mở được mic sau 10s.') });
    const p = listenOnce({ ...f.deps, log: (m) => log.push(m) });
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeUndefined();
    expect(f.events).not.toContain('beep');
    expect(log.join('\n')).toContain('không mở được mic');
  });
});
