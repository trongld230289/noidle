# NoIdle

**Giúp làm việc liền mạch: không bị ngắt khi đang tập trung việc khác, không mất thời gian chết giữa các phiên làm việc.**

Extension VS Code cho người chạy Claude Code, Copilot Chat hoặc Copilot CLI ở nhiều cửa sổ. Agent xong hay đang chờ, bạn nghe ngay qua loa hoặc tai nghe, kèm tên workspace. Trả lời bằng giọng là agent làm tiếp, không cần canh màn hình hay quay lại bàn phím.

▶ [Xem demo mô phỏng](https://claude.ai/artifact/Wv9hace8n5K1Ub2n35hcF9)

## Bạn có từng thế này?

- **Nhiều workspace, không biết cái nào cần mình.** Một cái xong mà không biết, một cái chờ chọn đáp án, một cái chờ approve. NoIdle đọc "Workspace X is done", "Workspace X cần approve", và cửa sổ đó nháy lên.
- **Làm trên nhiều máy.** Máy nào phát tiếng thì câu đọc cũng có tên workspace, nghe là biết việc nào xong, khỏi dò từng màn hình.
- **Nằm nghỉ một chút.** Agent xong thì giọng đọc tóm tắt, bạn nói việc tiếp theo, agent làm tiếp.
- **Đi tưới cây, nấu cơm.** Task xong là loa gọi, đứng đó nói việc kế tiếp hoặc approve, không phải chạy về gõ.

## Làm được gì

| | Claude Code | Copilot Chat | Copilot CLI |
|---|:-:|:-:|:-:|
| Đọc câu trả lời thành tiếng | ✓ | ✓ | ✓ |
| Báo cửa sổ nào đang cần bạn (nháy, đổi màu title bar) | ✓ | ✓ | ✓ |
| Đọc xong tự mở mic, nói là gửi tiếp | ✓ | ✓ (vào ô chat) | ✓ |
| Approve lệnh bằng giọng | ✓ | ✓ | ✓ |
| Chọn đáp án bằng giọng | ✓ | ✓ | ✓ |

Ngoài ra: bấm **F6** để nói thành chữ ở bất kỳ đâu trong VS Code (editor, terminal, ô chat), không cần agent. Nói tiếng Việt, tiếng Anh, hoặc để tự nhận.

## Chọn kiểu dùng

"Agent" ở đây là Claude Code, Copilot Chat hoặc Copilot CLI. Chỉ bật những gì bạn cần:

| Bạn muốn | Bật trong Settings | Cần Groq key? |
|---|---|:-:|
| Chỉ thấy cửa sổ nào xong, không cần tiếng | **Voice Response** + **Voice Mute** (taskbar vẫn nháy, title bar đổi màu) | Không |
| Nghe báo ngắn "Workspace A is done", không nghe nội dung | **Voice Response**, **Voice Style** = `announce` (không tốn token) | Không |
| Nghe agent tóm tắt câu trả lời | **Voice Response**, **Voice Style** = `recap` (mặc định, tốn thêm ít token) | Không |
| Nghe xong nói luôn việc tiếp theo | Thêm **Hands Free** | Có |
| Approve lệnh bằng giọng | Thêm **Voice Approve** | Có |
| Chỉ nói thành chữ bằng F6, không cần agent đọc | Không cần bật gì | Có |

Không cần nói thì bỏ qua bước lấy Groq key. Lưu ý: tắt hẳn **Voice Response** thì cửa sổ cũng không nháy nữa; muốn im lặng mà vẫn nháy thì dùng **Voice Mute**.

## Cài trong 3 bước

**1. Cài ffmpeg và Node.js** (ffmpeg để ghi âm và phát tiếng, Node.js để chạy phần đọc câu trả lời):
- Windows: `winget install ffmpeg` và `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install ffmpeg node`

Đã cài Claude Code bằng npm thì đã có Node.js. Mở lại VS Code sau khi cài.

**2. Lấy Groq key** (miễn phí, để chuyển giọng nói thành chữ; chỉ nghe, không nói thì bỏ qua bước này):
1. Mở [console.groq.com/keys](https://console.groq.com/keys), đăng nhập bằng Google hoặc GitHub.
2. Bấm **Create API Key**, copy key (bắt đầu bằng `gsk_`). Key chỉ hiện một lần.
3. Dán key khi extension hỏi. Extension chỉ hỏi lúc bạn dùng mic lần đầu: bấm **F6**, hoặc bật **Hands Free** / **Voice Approve**.

**3. Bật đọc câu trả lời:** `Ctrl+,` (Mac: `Cmd+,`), gõ `NoIdle`, bật **Voice Response**. Muốn rảnh tay hoàn toàn thì bật thêm **Hands Free** và **Voice Approve**.

Sau đó **mở lại phiên Claude Code hoặc Copilot CLI** (Copilot Chat: mở chat mới). Phiên đang mở từ trước sẽ không đọc.

**Kiểm tra:** chạy `NoIdle: Đọc thử giọng` (`Ctrl+Shift+P`) để nghe loa, bấm F6 và nói để thử mic.

> **macOS:** lần đầu bấm F6, macOS hỏi quyền micro cho Visual Studio Code, bấm **Allow**. Bản Mac chưa được test trên máy thật, gặp lỗi xin báo lại.

## Nói gì khi mic mở

| Lúc | Nói | Kết quả |
|---|---|---|
| Agent đọc xong, mic tự mở | yêu cầu tiếp theo | Ngừng 2,5 giây thì tự gửi (cần ít nhất 3 từ) |
| | "gửi" ở cuối câu | Gửi ngay |
| | "huỷ", "thôi", "dừng" | Tắt mic, không gửi |
| Agent xin chạy lệnh | "đồng ý", "ok", "approve" | Cho chạy |
| | "từ chối", "không" | Chặn |
| Agent hỏi chọn đáp án | "một", "số hai", tên lựa chọn, "tất cả" | Chọn |
| | "bỏ qua" | Để bạn chọn tay |

Với yêu cầu ngắn dưới 3 từ, nói thêm "gửi" ở cuối câu để gửi ngay, ví dụ "tiếp tục, gửi".

Khi approve hoặc chọn đáp án, im lặng hoặc nói không rõ thì chuyển về cơ chế xác nhận của agent. Lệnh nói hiểu cả tiếng Anh: send, cancel, yes, no, skip, all.

| Phím | Tác dụng |
|---|---|
| **F6** | Bắt đầu / dừng nghe. Mic đang tự mở thì F6 tắt mic. |
| **F7** | Bỏ qua câu đang đọc, câu kế tiếp phát tiếp. |

## An toàn khi approve bằng giọng

- Chỉ tool và lệnh thuộc danh sách cho phép mới duyệt được bằng giọng: đọc và sửa file thường, `npm test`, `npm run build`, `git status`, một số dạng `git commit`... Danh sách này không kiểm tra nội dung script hay Git hook; chỉ dùng với project bạn tin cậy.
- Xoá file, `git push`, `git reset --hard`, `sudo`, sửa `.env`, tool lạ hay MCP **không bao giờ duyệt bằng giọng**. Những lệnh này đi theo cơ chế xin quyền bình thường của agent.
- Ai đứng gần mic cũng nói được, nên chỉ bật `voiceApprove` khi bạn đang ở gần.

## Settings

`Ctrl+,` rồi gõ `NoIdle`. Settings chia 5 nhóm, giống thứ tự trong VS Code:

**1. Đọc câu trả lời**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Voice Response | tắt | Công tắc chính: đọc câu trả lời của Claude Code, Copilot Chat, Copilot CLI. |
| Voice Mute | tắt | Im lặng tạm thời, không cần restart. Lệnh nhanh: `NoIdle: Tắt/bật tiếng Claude Code`. |
| Voice Style | `recap` | `recap`: đọc tóm tắt nội dung (tốn thêm ít token mỗi lượt). `announce`: chỉ đọc "Workspace X is done" (tiếng Anh), không tốn token. |
| Voice Notify | bật | Đọc "Workspace X cần approve" / "cần bạn trả lời". |
| Voice Say Workspace | `auto` | Đọc tên workspace ở đầu câu. `auto`: chỉ khi mở hơn một cửa sổ. |

**2. Mic tự mở (rảnh tay)**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Hands Free | tắt | Đọc xong thì bíp và mở mic để bạn nói tiếp. Cũng dùng để chọn đáp án bằng giọng. |
| Voice Approve | tắt | Agent xin chạy lệnh thì mở mic để bạn nói đồng ý hay từ chối. |
| Hands Free Timeout Sec | `20` | Mic mở mà im lặng bao lâu thì tắt. |
| Hands Free Auto Send | bật | Tự gửi sau khi ngừng nói, xử lý nhận dạng xong và có ít nhất 3 từ. Câu ngắn hơn hoặc khi tắt setting này thì nói "gửi" để gửi. |
| Hands Free Send Delay Sec | `2.5` | Khoảng chờ trước khi tự gửi khi đã đủ điều kiện Auto Send; không tính thời gian xử lý nhận dạng. |
| Voice Approve Timeout Sec | `15` | Chờ bạn nói approve tối đa bao lâu. |

Tắt cả Hands Free và Voice Approve thì mic không bao giờ tự mở, chỉ mở khi bạn bấm F6.

**3. Báo cửa sổ đang cần bạn**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Attention Flash | bật | Windows: nút trên taskbar nháy cam. macOS: title bar nháy vài lần. |
| Attention Color | bật | Title bar đổi màu và status bar ghi "Claude xong" / "cần approve" tới khi bạn quay lại. |
| Attention Tint Color | `#15803d` | Màu title bar lúc đó. |

**4. Giọng đọc**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Tts Provider | `edge` | `edge`: miễn phí, không cần key. `elevenlabs`: hay hơn, cần key. |
| Voice | HoaiMy | Giọng Edge. Chọn giọng Multilingual nếu hay nói trộn Việt Anh. |
| Voice Rate | `+0%` | Tốc độ đọc, ví dụ `+20%`. |
| Eleven Labs Api Key | trống | Không bắt buộc. Cách lấy ghi ngay trong Settings. Gói miễn phí đọc khoảng 20.000 ký tự/tháng, hết thì tự về Edge. |
| Eleven Labs Voice Id | George | Giọng ElevenLabs. |
| Eleven Labs Model | Flash v2.5 | Flash tốn ít credit nhất. |
| Pronunciations | trống | Sửa cách đọc từ đọc sai, ví dụ `{"shipngo": "síp gô"}`. |

**5. Nói để gõ (F6)**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Groq Api Key | trống | Cần để nói thành chữ. Cách lấy ở trên. |
| Language | `vi` | `vi`, `en` hoặc `auto` (đoán theo từng prompt). Đổi cả giọng đọc, câu báo và nhận dạng. |
| Mic Device | trống | Micro dùng để nghe. Chọn bằng lệnh `NoIdle: Chọn micro`. |
| Refine | bật | AI sửa dấu, chính tả sau khi nghe. Tắt thì chữ ra nhanh hơn khoảng 1 giây. |
| Refine Model | `gpt-oss-120b` | Model Groq dùng để sửa câu. |
| Glossary | trống | Từ hay bị nghe sai: tên project, tên biến, từ tiếng Anh. |
| Typing Delay Ms | `12` | Hiệu ứng gõ từng ký tự. `0` là chèn cả cụm. |
| Ffmpeg Path | `ffmpeg` | Đường dẫn ffmpeg nếu không có trong PATH. |

## Câu hỏi thường gặp

**Có tốn tiền không?** Không bắt buộc tốn gì: Groq và giọng Edge đều miễn phí. ElevenLabs là tuỳ chọn. Kiểu `recap` làm agent viết thêm đoạn tóm tắt nên tốn thêm ít token mỗi lượt, không muốn thì chọn `announce`.

**Giọng nói của tôi đi đâu?** Audio và Glossary gửi lên Groq để nhận dạng. Khi bật Refine (mặc định), chữ nhận dạng, ngữ cảnh vừa nói và Glossary cũng gửi tới Groq để sửa câu. Đoạn cần đọc gửi lên Edge hoặc ElevenLabs để tạo giọng. Extension không có máy chủ riêng; log được lưu trên máy bạn.

**Không dùng Claude hay Copilot thì dùng được không?** Được, F6 vẫn nói thành chữ ở mọi nơi trong VS Code.

**Bật rồi mà không nghe đọc?** Mở lại phiên Claude Code / Copilot CLI (Copilot Chat: mở chat mới). Chạy `NoIdle: Đọc thử giọng` để kiểm tra loa. Kiểm tra Voice Mute đang tắt.

**Muốn im lặng một lúc?** Bật Voice Mute hoặc chạy `NoIdle: Tắt/bật tiếng Claude Code`. Có hiệu lực ngay.

**Mở nhiều cửa sổ thì mic mở ở đâu?** Ở cửa sổ của agent vừa xong. Copilot Chat nhận lời nói trong ô chat. Claude Code và Copilot CLI nhận trong đúng terminal đang chạy agent, nên hãy chạy chúng trong terminal của VS Code. Chạy ở terminal ngoài VS Code thì vẫn nghe đọc, nhưng mic không tự mở để tránh gõ nhầm chỗ.

**Copilot Chat hỏi approve cả lệnh bình thường?** Copilot Chat gọi hook trước mọi lần chạy tool, nên khi bật Voice Approve có thể hỏi cả lệnh vốn đã được cho phép. Tắt Voice Approve nếu thấy phiền.

**Chạy trên Mac được không?** Được, nhưng chưa test trên máy thật. Linux chưa hỗ trợ.

## Khi gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| Không tìm thấy ffmpeg | Cài ffmpeg rồi mở lại VS Code, hoặc điền đường dẫn vào Ffmpeg Path. |
| Bấm Đọc thử giọng báo không chạy được node | Cài Node.js (bước 1) rồi mở lại VS Code. |
| Sai key | Chạy `NoIdle: Set Groq API Key`, nhập lại. |
| Nói mà không ra chữ | Kiểm tra mic trong cài đặt Sound của máy (macOS: thêm quyền mic cho VS Code ở Privacy & Security > Microphone). Chạy `NoIdle: Chọn micro`. |
| F6 trong terminal ra ký tự lạ | Mở lại VS Code; extension tự thêm F6 vào `terminal.integrated.commandsToSkipShell` lần đầu chạy. |
| Lỗi mạng khi đang nói | Chạy `NoIdle: Gửi lại audio cuối`, khỏi nói lại. |
| Từ tiếng Anh bị viết thành âm Việt | Thêm từ đó vào Glossary. |
| Đọc sai một từ | Thêm vào Pronunciations. |

Xem chi tiết từng lượt ở `View > Output`, kênh **NoIdle**. Log giọng đọc nằm ở `noidle-tts/hook.log` trong thư mục tạm của máy (lệnh `Đọc thử giọng` hiện đường dẫn đầy đủ).

## Riêng tư

- Audio mic và Glossary gửi tới Groq để nhận dạng. Audio lượt ghi cuối và cụm nhận dạng bị lỗi có thể được giữ trong bộ nhớ để debug hoặc gửi lại; chỉ ghi audio mic ra file khi bạn chạy lệnh lưu audio để debug.
- Khi bật Refine (mặc định), chữ nhận dạng, tối đa 300 ký tự ngữ cảnh vừa nói và Glossary được gửi tới Groq để sửa câu.
- Đoạn cần đọc gửi tới Edge hoặc ElevenLabs. Audio câu ngắn được cache trong thư mục tạm `noidle-tts`, xoá là sạch.
- Key lưu trong Settings. Nếu bật Settings Sync, thêm `noIdle.groqApiKey` và `noIdle.elevenLabsApiKey` vào `settingsSync.ignoredSettings`.
- Chữ bạn nói được ghi vào log để kiểm tra khi nhận dạng sai. Log chỉ nằm trên máy bạn.

---

Tên cũ: Vi Voice. Setting cũ `viVoice.*` được tự chuyển sang `noIdle.*` lúc khởi động. Cách hoạt động chi tiết: [docs/how-it-works.md](docs/how-it-works.md).
