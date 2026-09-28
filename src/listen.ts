export interface ListenDeps {
  /** Mở mic; resolve khi mic đã thực sự đẩy dữ liệu (ffmpeg lạnh mất ~2s). onData nhận PCM live. */
  start(onData: (chunk: Uint8Array) => void): Promise<void>;
  /** Bíp báo "nói đi"; resolve khi phát xong. */
  beep(): Promise<void>;
  /** Tạo bộ cắt cụm; gọi onSegment với cụm tiếng nói đầu tiên. */
  segmenter(onSegment: (pcm: Uint8Array) => void): { push(chunk: Uint8Array): void };
  /** Đăng ký hàm huỷ (người dùng vừa gửi prompt, setting đổi...). */
  onCancel(cancel: () => void): void;
  /** Chờ tiếng nói tối đa bao lâu, tính từ lúc bíp xong. */
  timeoutMs: number;
  /** Bỏ ngần này ms audio ngay sau bíp: loa còn vọng đuôi bíp, mic thu vào sẽ thành "tiếng nói" 180ms. */
  guardMs?: number;
  log?: (msg: string) => void;
}

/**
 * Nghe một câu cho hook (approve, chọn đáp án). Thứ tự bắt buộc: mở mic và chờ dữ liệu chảy, RỒI mới bíp.
 * Bíp trước rồi mở mic là mất câu: ffmpeg lạnh mất vài giây, người dùng nói "approve" ngay sau bíp thì
 * mic chưa thu; log toàn "không nghe thấy gì" hoặc nghe "" (chỉ còn đuôi câu). Audio trong lúc bíp và
 * guardMs sau đó bị bỏ để không thu tiếng loa. Trả PCM của cụm đầu tiên, hoặc undefined nếu bị huỷ,
 * hết giờ hay mic không mở được.
 */
export function listenOnce(deps: ListenDeps): Promise<Uint8Array | undefined> {
  return new Promise<Uint8Array | undefined>((resolve) => {
    let done = false;
    let listening = false;
    let cancelled = false;
    let startSettled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (v?: Uint8Array) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    // Huỷ lúc mic còn đang mở: chờ start xong rồi mới trả, để bên gọi stop() được thật (cờ recording chỉ bật
    // sau khi start xong; trả sớm là bên gọi thấy chưa ghi, bỏ qua stop, mic bật lên sau đó không ai tắt).
    deps.onCancel(() => {
      cancelled = true;
      if (startSettled) finish(undefined);
    });
    const seg = deps.segmenter((pcm) => finish(pcm));
    void (async () => {
      try {
        await deps.start((chunk) => {
          if (listening) seg.push(chunk);
        });
      } catch (err) {
        startSettled = true;
        deps.log?.(`ask: không mở được mic: ${(err as Error).message}`);
        finish(undefined);
        return;
      }
      startSettled = true;
      if (cancelled) {
        finish(undefined);
        return;
      }
      await deps.beep();
      if (done) return;
      timer = setTimeout(() => {
        listening = true;
        timer = setTimeout(() => finish(undefined), deps.timeoutMs);
      }, deps.guardMs ?? 0);
    })();
  });
}
