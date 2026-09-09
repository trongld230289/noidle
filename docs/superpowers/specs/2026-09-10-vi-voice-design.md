# Vi Voice — VS Code extension gõ tiếng Việt bằng giọng nói

Ngày: 2026-09-10. Trạng thái: đã duyệt.

## Mục tiêu

Người dùng focus vào một ô nhập trong VS Code (terminal tích hợp đang chạy
Claude Code, Copilot Chat, hoặc editor), nhấn phím tắt, nói tiếng Việt xen
tiếng Anh, nhấn phím tắt lần nữa. Chữ đã nhận dạng được chèn vào đúng ô đó,
không tự gửi (không Enter). Chi phí bằng 0: dùng gói free của Groq.

Ngoài phạm vi: cửa sổ ngoài VS Code, giữ-phím-để-nói, chạy offline, hỗ trợ
ngôn ngữ khác ngoài vi (Whisper vẫn nhận từ tiếng Anh xen trong câu).

## Kiến trúc

```
RCtrl+RAlt ──AutoHotkey──▶ Ctrl+Alt+Space ──▶ VS Code keybinding (3 biến thể theo focus)
                                                     │
                                    ┌────────────────┴───────────────┐
                                    ▼                                ▼
                            viVoice.toggle(target)            StatusBar: 🎤 / ⏳ / ✓
                                    │
              start ────────────────┼──────────────── stop
                ▼                                       ▼
        Recorder webview                       Recorder webview
        getUserMedia + MediaRecorder            → postMessage(audio bytes)
                                                        │
                                                        ▼
                                              Transcriber (Groq whisper-large-v3, language=vi)
                                                        │
                                                        ▼
                                              Injector.insert(target, text)
```

Ba module trong extension host, một webview, một script AutoHotkey.

### 1. Hotkey

- `hotkey/vi-voice.ahk` (AutoHotkey v2): `RCtrl & RAlt::Send "^!{Space}"`.
  Người dùng chạy script này lúc khởi động Windows. Không có AutoHotkey thì
  nhấn thẳng Ctrl+Alt+Space.
- `package.json` khai báo 3 keybinding cùng phím `ctrl+alt+space`, khác `when`,
  mỗi cái gọi `viVoice.toggle` với tham số đích:
  - `terminalFocus` → `{ target: "terminal" }`
  - `inChatInput` → `{ target: "chat" }`
  - `editorTextFocus` → `{ target: "editor" }`
  - không thoả cái nào → `{ target: "clipboard" }` (keybinding không có `when`, thứ tự thấp nhất).
- Đích được chốt lúc **bắt đầu** ghi. Lúc dừng, người dùng có thể đã đổi focus,
  vẫn chèn vào đích ban đầu.

### 2. Recorder (webview)

- `WebviewPanel` mở ở `ViewColumn.Beside`, `retainContextWhenHidden: true`,
  giữ suốt phiên để không xin quyền mic lại. Nội dung: một dòng trạng thái,
  không có nút.
- Nhận message `start` → `getUserMedia({audio:true})`, `MediaRecorder`
  mimeType `audio/webm;codecs=opus`. Nhận `stop` → gom chunks thành Blob →
  `arrayBuffer` → `postMessage({type:"audio", bytes})`.
- Lỗi quyền mic → `postMessage({type:"error", code:"mic-denied"})`.
- Ghi quá 120 giây tự dừng (bảo vệ khỏi quên tắt).

### 3. Transcriber

- `POST https://api.groq.com/openai/v1/audio/transcriptions`, multipart:
  `file` (audio.webm), `model=whisper-large-v3`, `language=vi`,
  `response_format=json`, `prompt` = câu tiếng Việt có xen thuật ngữ code
  (refactor, commit, pull request, function, component…) để Whisper giữ nguyên
  từ tiếng Anh.
- API key trong `context.secrets` với khoá `viVoice.groqApiKey`. Lệnh
  `viVoice.setApiKey` mở InputBox (password). Khi chưa có key mà toggle, mở
  InputBox luôn rồi tiếp tục.
- Hậu xử lý: trim, bỏ dấu chấm cuối câu nếu Whisper thêm vào (thường thừa khi
  gõ prompt).
- Dùng `fetch` global của Node trong extension host, timeout 30 giây.

### 4. Injector

| target      | cách chèn                                                        |
|-------------|------------------------------------------------------------------|
| terminal    | `vscode.window.activeTerminal.sendText(text, false)`              |
| chat        | `vscode.commands.executeCommand("type", { text })`                |
| editor      | `vscode.commands.executeCommand("type", { text })`                |
| clipboard   | `vscode.env.clipboard.writeText(text)` + thông báo "đã copy"      |

Nếu `type` ném lỗi hoặc `activeTerminal` là undefined → rơi về clipboard.

### 5. Trạng thái và lỗi

Status bar item bên phải, ba trạng thái: `$(mic) Vi Voice` (rảnh),
`$(record) Đang nghe…` (đỏ), `$(sync~spin) Đang chuyển chữ…`. Bấm vào item
cũng toggle được (đích = clipboard).

| Lỗi                    | Xử lý                                                          |
|------------------------|----------------------------------------------------------------|
| Chưa có API key        | Mở InputBox nhập key, lưu, tiếp tục                            |
| Mic bị từ chối         | Thông báo lỗi kèm hướng dẫn, về rảnh                           |
| Groq 401               | Thông báo key sai, nút "Nhập lại key"                           |
| Groq 429 / mạng / 5xx  | Thông báo lỗi, giữ audio cuối, lệnh `viVoice.retry` gửi lại    |
| Audio < 0.5 giây       | Bỏ qua, về rảnh, không gọi API                                  |

## Cấu trúc repo

```
vi-voice/
  package.json            contributes: commands, keybindings, configuration
  src/extension.ts        activate: đăng ký lệnh, status bar, nối các module
  src/recorder.ts         quản lý webview, promise start/stop → Uint8Array
  src/transcriber.ts      gọi Groq, hậu xử lý
  src/injector.ts         chèn text theo target
  src/status.ts           status bar
  media/recorder.html     webview: getUserMedia + MediaRecorder
  hotkey/vi-voice.ahk     RCtrl+RAlt → Ctrl+Alt+Space
  test/                   vitest cho transcriber (mock fetch) và injector (mock vscode)
```

Build: esbuild bundle → `dist/extension.js`. Đóng gói `vsce package` →
cài bằng `code --install-extension vi-voice-x.y.z.vsix`.

## Kiểm thử

- Unit (vitest): transcriber tạo đúng multipart và parse response, hậu xử lý
  bỏ dấu chấm; injector chọn đúng lệnh theo target và rơi về clipboard khi lỗi.
- Spike đầu tiên (trước khi code phần còn lại): webview trong VS Code 1.106 có
  lấy được mic qua `getUserMedia` không. Nếu không, đổi Recorder sang spawn
  `ffmpeg -f dshow` và cập nhật spec.
- Thủ công: ba đích thật (terminal chạy Claude Code, Copilot Chat, editor),
  câu tiếng Việt có xen "refactor function claimNext".
