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
| Đọc xong tự mở mic, nói là gửi tiếp | ✓ | ✓ | ✓ |
| Approve lệnh bằng giọng | ✓ | ✓ | ✓ |
| Chọn đáp án bằng giọng | ✓ | ✓ | ✓ |

Ngoài ra: bấm **F6** để nói thành chữ ở bất kỳ đâu trong VS Code (editor, terminal, ô chat), không cần agent. Nói tiếng Việt, tiếng Anh, hoặc để tự nhận.

## Chọn kiểu dùng

**Mặc định sau khi cài** (chưa cần key gì): agent xong → cửa sổ nháy, title bar đổi màu → đọc recap câu trả lời. Muốn nói yêu cầu tiếp, chọn đáp án và approve lệnh an toàn bằng giọng thì bật **Hands Free**; cần Groq key.

- Không cần nói thì không cần lấy Groq key.
- Không cần nghe agent đọc thì tắt **Voice Response**, cửa sổ vẫn nháy.
- Chỉ cần nghe ngắn gọn "Workspace A is done" thì chọn **Voice Style** = `announce`.

## Cài trong 3 bước

**1. Cài ffmpeg và Node.js** (ffmpeg để ghi âm và phát tiếng, Node.js để chạy phần đọc câu trả lời):
- Windows: `winget install ffmpeg` và `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install ffmpeg node`

Đã cài Claude Code bằng npm thì đã có Node.js. Extension tự tìm ffmpeg vừa cài (kể cả khi shell đang mở chưa có nó trong PATH) và ghi đường dẫn đầy đủ vào hook, nên chạy Claude từ PowerShell hay cmd đều có tiếng.

**2. Lấy Groq key** (miễn phí, để chuyển giọng nói thành chữ; chỉ nghe, không nói thì bỏ qua bước này):
1. Mở [console.groq.com/keys](https://console.groq.com/keys), đăng nhập bằng Google hoặc GitHub.
2. Bấm **Create API Key**, copy key (bắt đầu bằng `gsk_`). Key chỉ hiện một lần.
3. Dán key khi extension hỏi. Extension chỉ hỏi lúc bạn dùng mic lần đầu: bấm **F6**, hoặc bật **Hands Free**.

**3. Xong.** Đọc câu trả lời, nháy cửa sổ và đổi màu title bar đã bật sẵn. Muốn rảnh tay hoàn toàn thì `Ctrl+,` (Mac: `Cmd+,`), gõ `NoIdle`, bật thêm **Hands Free**.

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
- Ai đứng gần mic cũng nói được, nên chỉ bật Hands Free khi bạn đang ở gần.

## Settings

`Ctrl+,` rồi gõ `NoIdle`. Settings chia 5 nhóm, giống thứ tự trong VS Code:

**1. Đọc câu trả lời**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Voice Response | bật | Đọc câu trả lời và câu báo của Claude Code, Copilot Chat, Copilot CLI. Tắt thì không đọc; mic vẫn hoạt động theo Hands Free, cửa sổ vẫn nháy. Lệnh nhanh: `NoIdle: Tắt/bật giọng đọc`. |
| Voice Style | `recap` | `recap`: đọc tóm tắt nội dung (tốn thêm ít token mỗi lượt). `announce`: chỉ đọc "Workspace X is done" (tiếng Anh), không tốn token. |
| Recap Prompt | bản tiếng Việt sẵn | Dặn agent viết gì trong phần recap; nghe mệt thì sửa ngắn lại. Viết một thứ tiếng, extension tự dịch sang tiếng kia bằng Copilot Chat hoặc Claude Code đang có (không cần key). |
| Voice Notify | bật | Đọc "Workspace X cần approve" / "cần bạn trả lời". Tắt Voice Response thì không đọc dù đang bật. |
| Voice Say Workspace | `auto` | Đọc tên workspace ở đầu câu. `auto`: chỉ khi mở hơn một cửa sổ. |

**2. Mic tự mở (rảnh tay)**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Hands Free | tắt | Tự mở mic để bạn nói tiếp, chọn đáp án hoặc duyệt lệnh an toàn bằng giọng. Độc lập với Voice Response và Voice Notify; nếu có giọng đọc thì đợi đọc xong mới nghe. |
| Hands Free Timeout Sec | `20` | Mic mở mà im lặng bao lâu thì tắt. |
| Hands Free Auto Send | bật | Tự gửi sau khi ngừng nói, xử lý nhận dạng xong và có ít nhất 3 từ. Câu ngắn hơn hoặc khi tắt setting này thì nói "gửi" để gửi. |
| Hands Free Send Delay Sec | `2.5` | Khoảng chờ trước khi tự gửi khi đã đủ điều kiện Auto Send; không tính thời gian xử lý nhận dạng. |
| Voice Approve Timeout Sec | `15` | Chờ bạn nói approve tối đa bao lâu. |

Tắt Hands Free thì mic không bao giờ tự mở, chỉ mở khi bạn bấm F6.

Tắt Voice Response hoặc Voice Notify không tắt Hands Free. Khi không có giọng đọc, xem nội dung trên màn hình và chờ bíp để nói. Copilot Chat không báo cho hook biết khi nào hộp duyệt hiện, nên với lệnh terminal mà setting auto-approve của VS Code (`chat.tools.terminal.autoApprove`) không tự duyệt, NoIdle chờ khoảng 2,5 giây: lệnh chạy ngay (đã được cho phép, kể cả "Allow in this session") thì im; không thấy chạy thì đọc "cần approve" và nháy cửa sổ. Menu Allow của VS Code vẫn nguyên vì NoIdle không ép hộp duyệt.

**3. Báo cửa sổ đang cần bạn**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Attention Flash | bật | Windows: nút trên taskbar nháy cam. Agent chạy ở Windows Terminal, cmd hay PowerShell rời thì nháy cửa sổ đó. macOS: title bar nháy vài lần. |
| Attention Color | bật | Title bar đổi màu và status bar ghi "Claude xong" / "cần approve" tới khi bạn quay lại. |
| Attention Tint Color | `#15803d` | Màu title bar lúc đó. |

**4. Giọng đọc**

| Setting | Mặc định | Ý nghĩa |
|---|---|---|
| Tts Provider | `edge` | `edge`: miễn phí, không cần key. `elevenlabs`: hay hơn, cần key. |
| Voice | Brian | Giọng Edge. Brian đa ngôn ngữ, đọc trộn Việt Anh trong câu. Muốn tiếng Việt chuẩn hơn thì chọn Hoài My hoặc Nam Minh. |
| Voice Rate | `+0%` | Tốc độ đọc, ví dụ `+20%`. |
| Eleven Labs Api Key | trống | Không bắt buộc. Cách lấy ghi ngay trong Settings. Gói miễn phí đọc khoảng 20.000 ký tự/tháng, hết thì tự về Edge. |
| Eleven Labs Voice Id | George | Giọng ElevenLabs. |
| Eleven Labs Model | Flash v2.5 | Flash tốn ít credit nhất. |
| Pronunciations | trống | Sửa cách đọc từ đọc sai, ví dụ `{"acme": "ác mi"}`. |

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

**Bật rồi mà không nghe đọc?** Mở lại phiên Claude Code / Copilot CLI (Copilot Chat: mở chat mới). Chạy `NoIdle: Đọc thử giọng` để kiểm tra loa. Kiểm tra Voice Response đang bật.

**Muốn im lặng một lúc?** Tắt Voice Response hoặc chạy `NoIdle: Tắt/bật giọng đọc`. Có hiệu lực ngay, cửa sổ vẫn nháy.

**Mở nhiều cửa sổ thì mic mở ở đâu?** Ở cửa sổ của agent vừa xong. Copilot Chat nhận lời nói trong ô chat. Claude Code và Copilot CLI nhận trong đúng terminal đang chạy agent, nên hãy chạy chúng trong terminal của VS Code. Chạy ở terminal ngoài VS Code thì vẫn nghe đọc, nhưng mic không tự mở để tránh gõ nhầm chỗ.

**Copilot Chat hỏi approve cả lệnh bình thường?** Chỉ khi bật Hands Free và lệnh nằm trong danh sách an toàn của NoIdle mà bạn im lặng: NoIdle trả về hộp duyệt để bạn bấm tay. Lệnh khác NoIdle không ép hộp duyệt; VS Code tự quyết theo setting auto-approve. Nghe "cần approve" mà lệnh đã chạy rồi là lệnh mất hơn 2,5 giây mới bắt đầu (terminal không có shell integration); tắt Voice Notify nếu thấy phiền.

**Copilot CLI đang chạy mà cứ nghe "cần approve", hoặc một câu hỏi bị báo hai lần?** NoIdle không dùng sự kiện kiểm tra quyền của CLI để báo đang chờ duyệt thủ công. Câu hỏi thủ công chỉ báo khi hộp thoại xuất hiện, không báo thêm lúc chuẩn bị gọi tool. Báo approve thủ công cần CLI phát thông báo `permission_prompt`; phiên bản không phát sự kiện này vẫn hiện hộp duyệt nhưng không có tiếng báo. Khi transcript CLI có đủ sự kiện vòng đời quyền, NoIdle bỏ thông báo nếu yêu cầu đã kết thúc, kể cả trong lúc chờ nháy cửa sổ, xếp hàng hoặc tổng hợp giọng. Nếu không đối chiếu được, NoIdle ghi log và giữ cách báo cũ. Khi bật Hands Free, NoIdle vẫn có thể hỏi duyệt bằng giọng cho lệnh an toàn trước khi CLI tự kiểm tra quyền.

**Chạy trên Mac được không?** Được, nhưng chưa test trên máy thật. Linux chưa hỗ trợ.

## Khi gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| Không tìm thấy ffmpeg, hoặc cửa sổ nháy mà không có tiếng | Bấm **Cài ffmpeg** trên cảnh báo (chạy winget/brew giúp, đóng terminal là xong), hoặc cài tay rồi đổi bất kỳ setting NoIdle nào để extension tìm lại, hoặc điền đường dẫn vào Ffmpeg Path. |
| Báo cần Node.js, hoặc Copilot Chat hiện "Warning from ... hook" | Cài Node.js (bước 1) rồi mở lại VS Code. |
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
