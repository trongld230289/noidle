/**
 * Chạy một việc có độ trễ thất thường (Edge TTS: lúc nửa giây, lúc mười giây, lúc đóng kết nối giữa chừng)
 * theo kiểu "hedged request": quá hedgeMs chưa xong thì mở thêm một lần nữa song song, lấy kết quả nào về trước;
 * lần nào lỗi thì mở lần khác ngay, không chờ. Tối đa maxAttempts lần, không quá maxInFlight lần cùng lúc.
 */
export interface HedgeOptions {
  /** Sau bao lâu chưa có kết quả thì mở thêm lần thử nữa. */
  hedgeMs: number;
  /** Tổng số lần thử tối đa. */
  maxAttempts: number;
  /** Số lần thử được chạy song song, mặc định 2 để không bị Edge chặn vì mở nhiều kết nối. */
  maxInFlight?: number;
  onEvent?: (msg: string) => void;
}

export function hedged<T>(attempt: (n: number) => Promise<T>, opts: HedgeOptions): Promise<T> {
  const maxInFlight = opts.maxInFlight ?? 2;
  const note = opts.onEvent ?? (() => undefined);
  return new Promise<T>((resolve, reject) => {
    let started = 0;
    let inFlight = 0;
    let done = false;
    let lastErr: Error = new Error('không thử lần nào');
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (done || started >= opts.maxAttempts) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (done) return;
        note(`hedge: lần ${started} chưa xong sau ${opts.hedgeMs}ms, mở thêm lần ${started + 1}`);
        launch();
      }, opts.hedgeMs);
    };

    const launch = () => {
      if (done || started >= opts.maxAttempts || inFlight >= maxInFlight) return;
      const n = ++started;
      inFlight++;
      let p: Promise<T>;
      try {
        p = attempt(n);
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (v) => {
          inFlight--;
          finish(() => resolve(v));
        },
        (err: Error) => {
          inFlight--;
          if (done) return;
          lastErr = err;
          note(`lần ${n} lỗi: ${err.message}`);
          if (started < opts.maxAttempts) launch();
          else if (inFlight === 0) finish(() => reject(lastErr));
        },
      );
      arm();
    };

    launch();
  });
}
