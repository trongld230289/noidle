import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hedged } from '../src/hedge';

/** Một lần thử điều khiển được: tự chọn lúc resolve/reject. */
function controllable<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('hedged', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lần đầu nhanh thì chỉ gọi một lần', async () => {
    const attempt = vi.fn(async () => 'a');
    const p = hedged(attempt, { hedgeMs: 1000, maxAttempts: 3 });
    await expect(p).resolves.toBe('a');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('lần đầu chậm quá hedgeMs thì mở thêm lần hai, lấy kết quả về trước', async () => {
    const first = controllable<string>();
    const second = controllable<string>();
    const attempt = vi.fn((n: number) => (n === 1 ? first.promise : second.promise));
    const events: string[] = [];
    const p = hedged(attempt, { hedgeMs: 1000, maxAttempts: 3, onEvent: (e) => events.push(e) });

    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);

    second.resolve('b');
    await expect(p).resolves.toBe('b');
    expect(events.some((e) => e.includes('hedge'))).toBe(true);
    // Kết quả muộn của lần đầu bị bỏ qua, không gây lỗi.
    first.resolve('a');
    await vi.runAllTimersAsync();
  });

  it('lần đầu lỗi thì thử lại ngay, không chờ hedgeMs', async () => {
    const second = controllable<string>();
    const attempt = vi.fn((n: number) => (n === 1 ? Promise.reject(new Error('closed')) : second.promise));
    const p = hedged(attempt, { hedgeMs: 5000, maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(2);
    second.resolve('ok');
    await expect(p).resolves.toBe('ok');
  });

  it('không mở quá maxInFlight lần cùng lúc; khi một lần lỗi thì mở tiếp', async () => {
    const slots = [controllable<string>(), controllable<string>(), controllable<string>()];
    const attempt = vi.fn((n: number) => slots[n - 1].promise);
    const p = hedged(attempt, { hedgeMs: 1000, maxAttempts: 3, maxInFlight: 2 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(2); // đầy slot, không mở lần ba

    slots[0].reject(new Error('closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(3);

    slots[2].resolve('c');
    await expect(p).resolves.toBe('c');
    slots[1].resolve('b');
  });

  it('hết maxAttempts mà đều lỗi thì reject bằng lỗi cuối', async () => {
    let n = 0;
    const attempt = vi.fn(async () => {
      n++;
      throw new Error(`fail ${n}`);
    });
    const p = hedged(attempt, { hedgeMs: 1000, maxAttempts: 3 });
    await expect(p).rejects.toThrow('fail 3');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('lần muộn lỗi sau khi đã có kết quả thì bỏ qua', async () => {
    const first = controllable<string>();
    const second = controllable<string>();
    const attempt = vi.fn((n: number) => (n === 1 ? first.promise : second.promise));
    const p = hedged(attempt, { hedgeMs: 100, maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(100);
    first.resolve('a');
    await expect(p).resolves.toBe('a');
    second.reject(new Error('late'));
    await vi.runAllTimersAsync();
  });
});
