/**
 * Đường ống "tổng hợp trước, phát theo thứ tự": luôn giữ tối đa `ahead` mục đang được tạo (tính cả mục
 * sắp tiêu thụ), kết quả được giao đúng thứ tự mục. Dùng cho TTS: Edge có lúc mất 5-8 giây một khối trong khi
 * khối trước chỉ phát 5 giây, tổng hợp một khối phía trước là không đủ, loa im giữa chừng.
 */
export interface PrefetchOptions<T, R> {
  /** Số mục được tạo song song, kể cả mục đang chờ tiêu thụ. 1 = tuần tự. */
  ahead: number;
  produce: (item: T, index: number) => Promise<R>;
  /** next: promise của mục kế (đã được tạo trước), để người tiêu thụ chờ đệm nếu muốn. */
  consume: (result: R, index: number, next: Promise<R> | undefined) => void | Promise<void>;
  /** Trả true thì dừng: không tiêu thụ thêm, không tạo thêm. */
  stopped?: () => boolean;
  /** Mục tạo lỗi thì bỏ qua và báo ở đây, các mục sau vẫn tiếp tục. */
  onError?: (err: Error, index: number) => void;
}

export async function prefetchInOrder<T, R>(items: T[], opts: PrefetchOptions<T, R>): Promise<void> {
  const ahead = Math.max(1, opts.ahead);
  const stopped = opts.stopped ?? (() => false);
  const pending: Array<Promise<R> | undefined> = [];

  const start = (i: number) => {
    if (i >= items.length || pending[i]) return;
    const p = opts.produce(items[i], i);
    // Mục được tạo trước có thể không bao giờ được await (dừng sớm); gắn sẵn catch để không thành unhandled rejection.
    p.catch(() => undefined);
    pending[i] = p;
  };

  const STOP = Symbol('stop');
  // Đang chờ một mục tạo chậm (Edge 5-8 giây) mà có lệnh dừng thì thoát ngay, không đợi mục đó xong.
  const untilStopped = () =>
    new Promise<typeof STOP>((resolve) => {
      const t = setInterval(() => {
        if (stopped()) {
          clearInterval(t);
          resolve(STOP);
        }
      }, 100);
      t.unref?.();
    });

  for (let i = 0; i < items.length && !stopped(); i++) {
    for (let j = i; j < i + ahead; j++) start(j);
    try {
      const result = await Promise.race([pending[i]!, untilStopped()]);
      if (result === STOP || stopped()) break;
      await opts.consume(result, i, pending[i + 1]);
    } catch (err) {
      opts.onError?.(err as Error, i);
    }
  }
}
