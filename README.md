# Vi Voice

Gõ tiếng Việt bằng giọng nói trong VS Code. Bấm **F6**, nói, bấm **F6** lần nữa. Chữ được chèn thẳng vào nơi bạn đang đứng: editor, terminal hoặc ô chat của Copilot.

Nhận dạng giọng nói dùng model Whisper large v3 chạy trên [Groq](https://groq.com). Groq có gói miễn phí, đủ dùng hằng ngày.

## Yêu cầu

| Thứ cần có | Ghi chú |
|---|---|
| Windows | Hiện chỉ hỗ trợ Windows (ghi âm qua DirectShow). |
| ffmpeg | Dùng để ghi âm từ micro. Cài bằng `winget install ffmpeg` hoặc tải tại https://ffmpeg.org, rồi đảm bảo `ffmpeg` có trong PATH. |
| Groq API key | Miễn phí. Xem cách lấy bên dưới. |

Kiểm tra ffmpeg đã sẵn sàng chưa:

```powershell
ffmpeg -version
```

## Bước 1: Lấy Groq API key

1. Mở https://console.groq.com/keys và đăng nhập (có thể dùng tài khoản Google hoặc GitHub).
2. Bấm **Create API Key**, đặt tên tuỳ ý, ví dụ `vi-voice`.
3. Copy key ngay khi nó hiện ra. Key bắt đầu bằng `gsk_`. Groq chỉ hiện key một lần, đóng hộp thoại rồi sẽ không xem lại được.

## Bước 2: Nhập key vào extension

Có ba cách, chọn một:

**Cách 1: Settings.** Bấm `Ctrl+,`, gõ `Vi Voice` vào ô tìm kiếm, dán key vào ô **Groq Api Key**.

**Cách 2: bấm F6 lần đầu.** Nếu chưa có key, extension sẽ hiện hộp nhập key ngay. Dán key vào và bấm Enter.

**Cách 3: Command Palette.** Bấm `Ctrl+Shift+P`, chạy `Vi Voice: Set Groq API Key`, dán key, Enter.

Cả ba cách đều lưu key vào setting `viVoice.groqApiKey` trong `settings.json`. Nếu bạn bật Settings Sync, hãy thêm `viVoice.groqApiKey` vào `settingsSync.ignoredSettings` để key không bị đồng bộ.

Nếu key sai hoặc hết hạn, extension báo lỗi kèm nút **Nhập lại key**.

## Bước 3: Dùng

1. Đặt con trỏ vào nơi muốn chèn chữ: editor, terminal hoặc ô chat Copilot.
2. Bấm **F6**. Thanh trạng thái góc dưới hiện đang nghe.
3. Nói bình thường. Extension tự cắt theo từng cụm khi bạn ngắt hơi và chèn chữ dần trong lúc bạn vẫn đang nói.
4. Bấm **F6** lần nữa để dừng. Tự động dừng sau 2 phút.

Chữ được chèn theo nơi đang focus:

| Đang focus | Kết quả |
|---|---|
| Editor | Chèn tại con trỏ, gõ từng ký tự. |
| Terminal | Gửi vào terminal đang mở. |
| Ô chat Copilot | Chèn vào ô chat. |
| Nơi khác | Copy vào clipboard và báo để bạn tự dán. |

Thuật ngữ lập trình tiếng Anh như `refactor`, `commit`, `pull request`, `unit test` được giữ nguyên, không bị dịch sang tiếng Việt.

Mỗi cụm sau khi nhận dạng được gửi thêm một lượt qua LLM trên Groq để sửa chính tả, dấu thanh, dấu câu và viết hoa. Bước này tốn thêm khoảng nửa giây mỗi cụm. Tắt bằng setting `viVoice.refine` nếu muốn chữ ra ngay.

## Nghe Claude Code trả lời bằng giọng nói

Bật setting `viVoice.voiceResponse`. Extension sẽ:

1. Thêm hai hook vào `~/.claude/settings.json`: một hook dặn Claude kết thúc mỗi câu trả lời bằng một dòng bắt đầu bằng 🔊 tóm tắt ngắn gọn kiểu nói chuyện, một hook đọc dòng đó khi Claude trả lời xong.
2. Đọc bằng giọng tiếng Việt của Microsoft Edge (miễn phí, cần mạng), phát qua `ffplay` đi kèm ffmpeg.

Khi Claude Code cần bạn approve một lệnh hoặc chờ bạn chọn câu trả lời, extension đọc một câu ngắn kèm tên workspace: "Workspace shipngo cần approve" hoặc "Workspace vi voice cần bạn xác nhận câu trả lời". Chạy nhiều cửa sổ cùng lúc vẫn biết cửa sổ nào đang chờ. Mọi lượt đọc xếp hàng theo thứ tự đến, không chồng tiếng; chỉ khi cùng một phiên có câu trả lời mới thì câu cũ của phiên đó bị cắt. Tắt bằng `viVoice.voiceNotify`.

Phiên Claude Code đang mở cần khởi động lại để nhận hook. Chạy `Vi Voice: Đọc thử giọng` để kiểm tra loa. Đổi giọng nam hoặc nữ bằng `viVoice.voice`, chỉnh tốc độ bằng `viVoice.voiceRate`. Tắt setting thì hook được gỡ khỏi `settings.json`.

Mọi thứ từ dòng 🔊 đến hết câu trả lời sẽ được đọc. Claude được dặn viết phần này đủ nghĩa để nghe xong không cần nhìn màn hình: hỏi thông tin thì kể đủ các mục chính, báo cáo việc đã làm thì hai ba câu. Muốn nghe kỹ hơn nữa thì nói "đọc chi tiết". Nếu Claude không thêm dòng 🔊, extension đọc khoảng 300 ký tự đầu của câu trả lời, bỏ code và markdown. Lỗi đọc được ghi tại `%TEMP%\vi-voice-tts\hook.log`.

## Lệnh có sẵn

Mở bằng `Ctrl+Shift+P`, gõ `Vi Voice`:

| Lệnh | Tác dụng |
|---|---|
| Vi Voice: Bắt đầu / dừng nghe | Giống bấm F6. |
| Vi Voice: Set Groq API Key | Nhập hoặc đổi key. |
| Vi Voice: Gửi lại audio cuối | Gửi lại cụm vừa lỗi mạng hoặc lỗi server. |
| Vi Voice: Chọn micro | Liệt kê micro ffmpeg thấy được và chọn một cái. |
| Vi Voice: Lưu audio cuối ra file (debug) | Ghi lần thu cuối ra file WAV trong thư mục tạm để kiểm tra mic. |
| Vi Voice: Đọc thử giọng | Đọc một câu mẫu bằng giọng đã chọn để kiểm tra loa. |

## Cài đặt trong Settings (Ctrl+,)

Gõ `Vi Voice` vào ô tìm kiếm của Settings:

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| `viVoice.groqApiKey` | trống | Groq API key. |
| `viVoice.voiceResponse` | `false` | Đọc câu trả lời của Claude Code thành tiếng. |
| `viVoice.voiceNotify` | `true` | Đọc "Workspace X cần approve" hoặc "cần bạn xác nhận câu trả lời" khi Claude Code chờ bạn. |
| `viVoice.voice` | `vi-VN-HoaiMyNeural` | Giọng Việt HoaiMy hoặc NamMinh đọc tiếng Việt chuẩn nhất; giọng Multilingual như Ava, Andrew tự chuyển giữa tiếng Việt và tiếng Anh trong câu, hợp khi nói nhiều thuật ngữ. |
| `viVoice.voiceRate` | `+0%` | Tốc độ đọc. |
| `viVoice.ffmpegPath` | `ffmpeg` | Đường dẫn ffmpeg nếu không có trong PATH. |
| `viVoice.micDevice` | trống | Tên micro. Trống thì lấy micro đầu tiên. Nên đặt bằng lệnh `Vi Voice: Chọn micro`. |
| `viVoice.typingDelayMs` | `12` | Nghỉ bao nhiêu ms giữa các ký tự khi gõ vào editor. Đặt `0` để chèn nguyên cụm. |
| `viVoice.language` | `vi` | Mã ngôn ngữ báo cho Whisper. Để trống để Whisper tự nhận diện. |
| `viVoice.glossary` | `[]` | Từ tiếng Anh hay nói mà Whisper nghe sai, cùng tên project, tên biến, tên người. Whisper và LLM sẽ ưu tiên viết đúng các từ này. |
| `viVoice.refine` | `true` | Sửa câu bằng LLM sau khi nhận dạng. |
| `viVoice.refineModel` | `llama-3.3-70b-versatile` | Model Groq dùng để sửa câu. `llama-3.1-8b-instant` nhanh hơn nhưng kém hơn. |

Phím tắt mặc định là **F6**. Đổi phím trong `File > Preferences > Keyboard Shortcuts`, tìm `viVoice.toggle`. Lần đầu chạy, extension tự thêm `viVoice.toggle` vào `terminal.integrated.commandsToSkipShell` để phím tắt hoạt động trong terminal.

## Khi gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| Báo không tìm thấy ffmpeg | Cài ffmpeg, hoặc điền đường dẫn đầy đủ vào `viVoice.ffmpegPath`. |
| Báo sai key | Chạy `Vi Voice: Set Groq API Key`, nhập lại key `gsk_...`. |
| Không nghe thấy tiếng nói | Kiểm tra mic trong Windows Settings > Sound > Input. Chạy `Vi Voice: Chọn micro` để chọn đúng thiết bị. Dùng lệnh lưu audio để nghe thử file thu được. |
| Bấm F6 trong terminal ra ký tự lạ | Kiểm tra `terminal.integrated.commandsToSkipShell` trong Settings có chứa `viVoice.toggle`. |
| Lỗi mạng hoặc quá giới hạn | Chờ vài giây rồi chạy `Vi Voice: Gửi lại audio cuối`. |
| Từ tiếng Anh bị viết thành âm tiếng Việt (button thành "bất tính") | Thêm từ đó vào `viVoice.glossary`. Whisper nghe tiếng Việt trộn tiếng Anh chưa tốt, từ nào có trong prompt sẽ được viết đúng. |
| Muốn xem chữ thô trước khi sửa | Mở `View > Output`, chọn kênh **Vi Voice**. Mỗi cụm có chữ thô của Whisper, chữ sau lọc và chữ sau LLM. |

## Riêng tư

Âm thanh chỉ được gửi tới Groq để nhận dạng và không lưu ở đâu khác. Extension không thu thập gì thêm.
