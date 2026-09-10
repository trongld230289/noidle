# Extension giữ mic, hook chỉ ra hiệu (bước một)

Ngày: 2026-09-11. Trạng thái: đã chốt với người dùng trong chat.

## Vấn đề

Bản 1.5 có hai đường mic. F6 thu âm trong extension, chữ hiện trong terminal, sửa được rồi
Enter. Hands-free thì hook Stop tự bật ffmpeg bên trong lượt của Claude, chờ tới 20 giây,
rồi chặn Stop với lý do chứa câu nói. Hậu quả: Claude Code hiện "running hooks", không thấy
chữ, không sửa được, câu nói không phải prompt thật (UserPromptSubmit không chạy), hai bộ
VAD lệch nhau.

## Mục tiêu bước một

Lượt "Claude xong việc, chờ lệnh tiếp" dùng đúng đường mic của F6. Hook Stop thoát ngay.
Người dùng vẫn bấm Enter tay (v1). Approve và chọn đáp án giữ nguyên như 1.5 (bước hai mới gom).

## Thiết kế

### Kênh tín hiệu hook → extension

- Extension mỗi cửa sổ mở một server `net` trên named pipe `\.\pipe\vi-voice-<pid>`
  (Windows) hoặc `<tmp>/vi-voice-<pid>.sock`, và ghi một file đăng ký
  `%TEMP%/vi-voice-tts/windows/<pid>.json` = `{ pid, pipe, folders: [...workspace folders] }`.
  Xoá file khi deactivate.
- Hook tìm cửa sổ bằng `cwd` của hook input: chọn entry có folder là tiền tố dài nhất của cwd
  (so sánh không phân biệt hoa thường, dấu `/` `\`). Không nối được thì xoá entry chết.
- Thông điệp là một dòng JSON rồi đóng kết nối:
  - `{ "event": "listen", "session": "...", "cwd": "..." }` — mở mic nghe lệnh tiếp.
  - `{ "event": "submitted", "session": "...", "cwd": "..." }` — người dùng đã gửi prompt, tắt mic.

### Hook

- `speak` (Stop): handsFree thì `spawnPlay(text, 'speak', session, { listen: cwd })` rồi thoát.
  Không còn playNow, không còn block. Không có câu 🔊 thì gửi tín hiệu listen thẳng từ hook.
  `stop_hook_active` thì bỏ qua (giữ chống lặp).
- `play`: phát xong (hoặc bị cắt) mà có `--listen <cwd>` thì gửi tín hiệu listen. Mic vì thế chỉ
  mở sau khi loa phát xong, không nghe nhầm giọng Claude.
- `prompt` (UserPromptSubmit): in additionalContext như cũ, rồi gửi `submitted` (không chờ lâu,
  timeout ngắn, lỗi thì bỏ qua).
- `handsFreeTurn` bỏ. Timeout hook Stop hạ về 60 giây.

### Extension

- Module mới `src/signal.ts`: đăng ký cửa sổ, server nhận dòng JSON, `pickWindow`, `sendSignal`.
  Hàm thuần tách riêng để test.
- Nhận `listen`: nếu đang có session (F6 đang bật) thì bỏ qua. Không có terminal đang mở thì log
  và bỏ qua. Ngược lại: bíp ngắn (ffplay sine, như hook), rồi `toggle({ target: 'terminal' })`
  với cờ `auto`. Status bar hiện "Claude đang nghe…".
- Session auto tự tắt khi: không có cụm nào trong `handsFreeTimeoutSec` giây kể từ lúc mở hoặc kể
  từ cụm cuối; nhận `submitted`; hoặc người dùng bấm F6.
- Enter vẫn do người dùng bấm. Chữ đi qua transcribe + refine + inject y như F6.

### Ngoài phạm vi (bước hai)

Tự Enter khi im lặng; gom approve và chọn đáp án về mic của extension (hook gửi `ask`, chờ trả lời).

## Kiểm thử

- Unit: pickWindow (tiền tố dài nhất, hoa thường, dấu gạch), parse dòng JSON, vòng server-client
  qua pipe thật với tên ngẫu nhiên, registry đọc/ghi/xoá entry chết.
- Tay: bật handsFree, hỏi Claude một câu, nghe đọc xong, thấy bíp và status bar, nói, thấy chữ
  trong terminal, Enter, mic tắt; im lặng 20 giây mic tự tắt.
