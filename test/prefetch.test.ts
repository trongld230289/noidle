import { describe, it, expect } from 'vitest';
import { prefetchInOrder } from '../src/prefetch';

/** Promise điều khiển tay: gọi resolve/reject khi test muốn. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('prefetchInOrder', () => {
  it('delivers results in item order even when later items finish first', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const consumed: string[] = [];
    const run = prefetchInOrder(['a', 'b', 'c'], {
      ahead: 3,
      produce: (_item, i) => gates[i].promise,
      consume: (r) => void consumed.push(r),
    });
    gates[2].resolve('C');
    gates[1].resolve('B');
    await tick();
    expect(consumed).toEqual([]);
    gates[0].resolve('A');
    await run;
    expect(consumed).toEqual(['A', 'B', 'C']);
  });

  it('keeps at most `ahead` items in production before the first one is consumed', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const run = prefetchInOrder([0, 1, 2, 3, 4], {
      ahead: 3,
      produce: (item) => {
        started.push(item);
        return gates[item].promise;
      },
      consume: () => undefined,
    });
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve(0);
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates.forEach((g, i) => g.resolve(i));
    await run;
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('skips an item whose production fails, reports it, and continues', async () => {
    const consumed: number[] = [];
    const errors: number[] = [];
    await prefetchInOrder([1, 2, 3], {
      ahead: 2,
      produce: async (item) => {
        if (item === 2) throw new Error('boom');
        return item * 10;
      },
      consume: (r) => void consumed.push(r),
      onError: (_err, i) => void errors.push(i),
    });
    expect(consumed).toEqual([10, 30]);
    expect(errors).toEqual([1]);
  });

  it('hands the consumer the promise of the next item so it can wait for a buffer before playing', async () => {
    const seen: Array<number | undefined> = [];
    await prefetchInOrder([1, 2, 3], {
      ahead: 3,
      produce: async (item) => item,
      consume: async (r, _i, next) => {
        seen.push(next ? await next : undefined);
      },
    });
    expect(seen).toEqual([2, 3, undefined]);
  });

  it('returns promptly when stopped() turns true while waiting for a slow item', async () => {
    let stop = false;
    const never = new Promise<number>(() => undefined);
    const t0 = Date.now();
    const run = prefetchInOrder([1, 2], {
      ahead: 2,
      produce: async (item) => (item === 2 ? never : item),
      consume: () => undefined,
      stopped: () => stop,
    });
    setTimeout(() => (stop = true), 50);
    await run;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('stops consuming once stopped() reports true', async () => {
    const consumed: number[] = [];
    let stop = false;
    await prefetchInOrder([1, 2, 3, 4], {
      ahead: 2,
      produce: async (item) => item,
      consume: (r) => {
        consumed.push(r);
        if (r === 2) stop = true;
      },
      stopped: () => stop,
    });
    expect(consumed).toEqual([1, 2]);
  });
});
