# Bước hai: tự Enter, và approve / chọn đáp án qua mic của extension

Ngày: 2026-09-11. Trạng thái: người dùng chốt "múc luôn phần 2".

## Mục tiêu

1. Hands-free không cần bấm Enter: nói xong, ngắt hơi đủ lâu thì extension tự gửi.
2. Hook không mở mic ở đâu nữa. Approve và chọn đáp án cũng nghe qua mic của extension;
   hook chỉ gửi tín hiệu hỏi, chờ chữ nghe được, rồi quyết định như cũ.

## Phần A: tự Enter (extension)

- Session hands-free (`auto`) sau mỗi cụm đã chèn xong thì hẹn giờ `handsFreeSendDelaySec`
  (mặc định 2.5 giây). Hết giờ, nếu vẫn là session đó và không có cụm mới, và tổng chữ đã chèn
  có từ 3 từ trở lên, thì: tắt mic, chờ hàng đợi chèn xong, gửi Enter vào terminal đang mở.
  Dưới 3 từ thì không tự gửi, mic vẫn mở tới khi im lặng hết `handsFreeTimeoutSec`.
- Lệnh nói, nhận ra trên chữ Whisper thô của từng cụm (trước khi qua LLM):
  - cụm kết thúc bằng "gửi", "gửi đi", "send": bỏ từ đó khỏi chữ, chèn phần còn lại (nếu có), gửi Enter ngay.
  - cụm chỉ là "huỷ", "hủy", "thôi", "bỏ", "dừng", "xong": tắt mic, không gửi; chữ đã chèn để nguyên cho người dùng xử lý tay.
  - Hàm thuần `parseVoiceCommand(raw)` trong `src/decision.ts`, trả `{ command?: 'send' | 'cancel', text }`.
- Setting mới `viVoice.handsFreeAutoSend` (mặc định `true`) và `viVoice.handsFreeSendDelaySec` (mặc định `2.5`).
  Tắt autoSend thì như bước một: chỉ lệnh "gửi" mới gửi.
- Enter gửi bằng `terminal.sendText('', true)`.

## Phần B: tín hiệu `ask` (hook → extension → hook)

- Thông điệp mới `{ event: 'ask', session, cwd, timeoutSec }`. Khác `listen`/`submitted`, tín hiệu này
  có trả lời: extension ghi lại một dòng JSON `{ heard: string }` rồi đóng kết nối. Khung tin: mỗi dòng
  kết thúc bằng `\n`; server xử lý khi thấy `\n`, không dựa vào half-close.
- Extension nhận `ask`: nếu đang có session (F6 đang bật) hoặc đang trả lời một `ask` khác thì trả `''`
  ngay. Ngược lại: bíp, mở mic, lấy cụm tiếng nói đầu tiên (segmenter im lặng 1200 ms, minSpeech 180 ms),
  tắt mic, gửi Whisper (không qua LLM), trả chữ. Hết `timeoutSec` không ai nói thì trả `''`.
  Status bar hiện "Claude đang nghe" trong lúc đó. F6 trong lúc đang trả lời `ask` bị bỏ qua.
- Hook: `voiceApprove` và `voiceChoose` thay `listenAndTranscribe` bằng `askWindow(...)`. Không có cửa sổ
  (VS Code đóng, Claude chạy ngoài) thì coi như không nghe thấy: nói "bạn bấm tay nhé", hộp thoại hiện.
  Logic parseApproval / parseChoice / isDangerous giữ nguyên.
- Hook bỏ hẳn mic: xoá `src/listen.ts`, `beep()`, `listenAndTranscribe()`, mode `listen`. HookConfig
  chỉ còn `voiceApprove`, `approveTimeoutSec`, `handsFree`; extension không ghi API key, mic, từ điển
  vào file hook-config nữa.

## Ngoài phạm vi

Ngắt Claude đang đọc khi người dùng nói; báo agent nền xong việc.

## Kiểm thử

- Unit: `parseVoiceCommand`; `parseSignal` nhận `ask`; vòng `ask` qua pipe thật với server trả lời;
  `sendSignal` cũ vẫn chạy với khung dòng mới.
- Tay: hands-free nói một câu, im 2.5 giây thấy tự gửi; nói "gửi" thấy gửi ngay; approve bằng giọng
  thấy status bar VS Code "đang nghe" thay vì hook tự nghe; đóng VS Code thì approve rơi về hộp thoại.
