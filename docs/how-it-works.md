# NoIdle: cách hoạt động chi tiết

Tài liệu cho người muốn hiểu sâu hoặc đóng góp code. Hướng dẫn dùng nằm ở [README](../README.md).

## Đọc câu trả lời, thông báo và hook

Setting `noIdle.voiceResponse` mặc định bật (thiếu `node` thì extension không ghi hook và báo cách cài). Extension sẽ:

1. Đăng ký hook cho Claude Code trong `~/.claude/settings.json` và cho Copilot Chat (VS Code 1.110 trở lên) lẫn GitHub Copilot CLI trong `~/.copilot/hooks/noidle.json`. Hook dặn agent kết thúc bằng phần 🔊 để đọc thành tiếng, đọc khi trả lời xong và xử lý thông báo/câu hỏi nếu được bật. Một file Copilot dùng chung, không đăng ký hai lần cho Chat và CLI.
2. Đọc bằng giọng tiếng Việt của Microsoft Edge (miễn phí, cần mạng) hoặc ElevenLabs (xem bên dưới), phát qua `ffplay` đi kèm ffmpeg.

Muốn im lặng một lúc mà không phải mở phiên Claude Code mới: bật `noIdle.voiceMute` hoặc chạy lệnh `NoIdle: Tắt/bật tiếng Claude Code`. Hook vẫn đăng ký nhưng không đọc, không báo, không dặn Claude viết phần 🔊 và không mở mic; bật tắt có hiệu lực ngay ở lượt sau. Tắt `noIdle.voiceResponse` thì gỡ hẳn hook, phiên đang mở phải khởi động lại mới nhận.

Khi Claude Code hoặc Copilot CLI cần bạn approve một lệnh hoặc chờ bạn chọn câu trả lời, extension đọc một câu ngắn kèm tên workspace: "Workspace shipngo cần approve" hoặc "Workspace vi voice cần bạn xác nhận câu trả lời". Chạy nhiều cửa sổ cùng lúc vẫn biết cửa sổ nào đang chờ. Mọi lượt đọc xếp hàng theo thứ tự đến, không chồng tiếng; chỉ khi cùng một phiên có câu trả lời mới thì câu cũ của phiên đó bị cắt. Tắt bằng `noIdle.voiceNotify`.

### Approve bằng giọng nói

Bật `noIdle.voiceApprove`. Khi Claude Code xin quyền, hook đọc "Workspace X cần approve, nói approve hoặc từ chối" rồi mở mic nghe tối đa 15 giây. Nói "approve", "đồng ý", "ok" thì lệnh được duyệt; "từ chối", "không", "dừng" thì bị chặn; im lặng hoặc không rõ thì hộp thoại hiện như thường để bấm tay. Hook xác nhận lại bằng giọng "đã approve" hoặc "đã từ chối".

Chỉ khi cả câu là một lời xác nhận ("ok", "approve", "đồng ý", "cho phép", "go ahead"...) kèm nhiều nhất vài từ đệm ("ừ approve đi", "yes please", "đồng ý nhé") thì mới tính là đồng ý. Câu chứa từ đồng ý nhưng nói chuyện khác ("was that okay", "approve tomorrow", "ai đồng ý"), câu hỏi ("được không?"), câu có điều kiện ("only after tests pass") đều không tính, hộp thoại hiện để bấm tay. Từ chối thì nhận thoải mái, kể cả lẫn trong câu ("yes and no" là từ chối).

Approve bằng giọng đi theo danh sách trắng và phải khớp trọn lệnh, kể cả tham số: đọc file, tìm kiếm, sửa file thường; npm test, npm ci, npm run với tên script quen (test, lint, build, typecheck, check, format, dev...), npx vitest/tsc/eslint/prettier; pytest, cargo test, go test, dotnet test, make test; git status, diff, log, show, fetch, branch (chỉ liệt kê), add, commit; ls, cat, grep, find không có delete/exec. Lệnh được tách thành đối số thật như shell (bỏ nháy) rồi xét theo quy tắc từng lệnh, nên `find . "-delete"` hay `git branch "-D" x` không lách được. Mọi lệnh con nối bằng && hay ; đều phải khớp; xuống dòng, biến, lệnh con, chuyển hướng, ngoặc, backslash là không an toàn. Tool lạ kể cả MCP, lệnh chưa phân loại (node script.js, curl, npm run deploy, make deploy, npm install tên-gói...) và lệnh nguy hiểm (xoá đệ quy, git push, git reset --hard, git branch -f, drop table, sudo, docker prune, sửa file .env hay settings.json) luôn phải bấm tay; hook đọc "chưa nằm trong danh sách an toàn" hoặc "thuộc loại nguy hiểm" rồi thôi. Ai đứng gần mic cũng approve được, nên chỉ bật khi thật sự đang nằm nghe. Mic do extension mở ngay trong cửa sổ VS Code (status bar hiện "Claude đang nghe"), hook chỉ gửi tín hiệu hỏi và nhận chữ nghe được; VS Code đóng thì hộp thoại hiện như thường.

### Hands-free: nói chuyện khép kín

Bật `noIdle.handsFree`. Bấm F6 nói yêu cầu đầu tiên như thường. Từ đó:

1. Claude làm xong, hook đọc phần 🔊. Loa vừa im thì extension bíp một tiếng và mở mic ngay trong cửa sổ VS Code đang chạy Claude Code (status bar hiện "Claude đang nghe"), gõ vào đúng terminal đang chạy phiên Claude đó dù bạn đang chọn terminal khác hay focus sang app khác. Bạn nói yêu cầu tiếp theo, chữ hiện dần trong terminal y như khi bấm F6. Ngắt hơi khoảng `noIdle.handsFreeSendDelaySec` (mặc định 2,5 giây) là extension tự bấm Enter, với điều kiện đã có ít nhất ba từ. Nói "gửi" ở cuối câu thì gửi ngay; nói riêng một tiếng "huỷ", "thôi" hay "dừng" thì tắt mic, chữ để nguyên cho bạn sửa tay. Tắt `noIdle.handsFreeAutoSend` nếu muốn luôn tự bấm Enter.
2. Claude cần approve: như mục trên, nếu bật `noIdle.voiceApprove`.
3. Claude hỏi chọn đáp án: hook đọc câu hỏi và các lựa chọn theo số, rồi extension bíp và mở mic; bạn nói số hoặc tên lựa chọn, có thể chọn nhiều ("một và ba"), hoặc "tất cả". Hook nhắc lại lựa chọn rồi Claude làm tiếp. Nói "bỏ qua" hoặc không rõ thì hộp thoại hiện để chọn tay.
4. Mic mở mà quá `noIdle.handsFreeTimeoutSec` (mặc định 20 giây) không nghe ra chữ nào thì tự tắt. Đồng hồ này tính theo chữ thật sau lọc, không tính theo tiếng động: gõ phím, quạt hay tiếng ồn không giữ mic mở. Bấm F6 lúc đang nghe cũng tắt. Muốn nói tiếp thì bấm F6 như thường.

Chống tiếng gõ phím và câu bịa, bốn lớp: VAD chỉ nhận là tiếng nói khi có ồn liền mạch từ 120 ms (click gõ phím chỉ 10 đến 40 ms, cộng dồn bao nhiêu cũng không tính); bộ lọc bỏ các câu Whisper hay bịa trên tiếng ồn ở cả tiếng Việt lẫn tiếng Anh ("Thank you", "Thanks for watching", "Subscribe"...); cụm ngắn lặp đúng đuôi chữ vừa gõ bị bỏ; và nếu VAD vẫn thấy tiếng mà quá 8 giây không ra chữ mới thì coi là ồn, gửi luôn thay vì chờ mãi. Ngôn ngữ `auto` chỉ đổi theo cụm còn chữ sau lọc, câu bịa không đổi được ngôn ngữ phiên.

Bật tắt `noIdle.handsFree` có hiệu lực ngay, không cần restart Claude Code: tắt thì Claude đọc xong là thôi, không mở mic, không chờ. Gửi prompt mới trong lúc câu trả lời cũ còn đang đọc thì câu cũ đọc xong không mở mic nữa (play so số prompt của phiên lúc được tách ra với số hiện tại), vì Claude đang làm lượt mới. Lệnh nhanh: `NoIdle: Tắt/bật hands-free`.

Hook không bao giờ tự mở mic: khi Claude xong, hook Stop thoát ngay và tiến trình đọc chỉ gửi một tín hiệu qua named pipe cho đúng cửa sổ VS Code (chọn theo thư mục làm việc của phiên Claude Code); lúc cần approve hay chọn đáp án, hook gửi tín hiệu hỏi và chờ extension nghe xong trả chữ về. Vì vậy câu nói là prompt thật do bạn gõ bằng giọng, hiện trong màn hình chat, sửa được trước khi gửi, và Claude Code không phải chờ hook. Mỗi cửa sổ ghi một file đăng ký trong `noidle-tts/windows` trong thư mục tạm. Tín hiệu listen còn mang chuỗi pid tổ tiên của tiến trình Claude Code (Claude → wrapper → shell của terminal); extension so với pid shell của từng terminal trong cửa sổ để chọn đúng terminal đang chạy Claude, tra được cây tiến trình mà không khớp terminal nào thì không mở mic (agent chạy ngoài VS Code); chỉ khi hook không tra được cây tiến trình, Claude Code mới lấy terminal đang chọn. Tra cây tiến trình bằng PowerShell mất hơn một giây nên hook lưu chuỗi theo phiên và chỉ tra lại khi pid Claude đổi.

Phiên Claude Code/Copilot CLI đang mở cần khởi động lại để nhận hook; Copilot Chat nhận ở phiên chat mới. Chạy `NoIdle: Đọc thử giọng` để kiểm tra loa. Đổi giọng nam hoặc nữ bằng `noIdle.voice`, chỉnh tốc độ bằng `noIdle.voiceRate`. Tắt setting thì hook được gỡ khỏi `settings.json` và file hook Copilot bị xoá.

### Copilot Chat trong VS Code

Phiên **Local** hỗ trợ cả **duyệt lệnh** và **chọn đáp án bằng giọng**, ngoài đọc câu trả lời và mở mic vào ô chat. Bật `noIdle.voiceResponse`, `noIdle.voiceNotify`, `noIdle.voiceApprove` và `noIdle.handsFree`; cần VS Code hỗ trợ hook, `chat.useHooks` bật và workspace được tin cậy. Không cần bật `chat.useClaudeHooks`. Sau khi cập nhật extension, reload cửa sổ để đồng bộ hook rồi mở phiên Chat mới.

- **Duyệt lệnh:** hook `PreToolUse` đọc tên thao tác và lệnh/đường dẫn, rồi nghe "đồng ý" hoặc "từ chối". Hỗ trợ `run_in_terminal`, `create_file` và `replace_string_in_file`, dùng danh sách an toàn ở trên. Lệnh nguy hiểm, file nhạy cảm và yêu cầu nâng quyền/thoát sandbox chuyển sang xác nhận thủ công, không mở mic. Im lặng hoặc nghe không rõ cũng yêu cầu xác nhận tay. Patch nhiều file, tool MCP và tool chưa phân loại không được NoIdle cấp quyền; giữ cơ chế quyền hiện tại của VS Code. Các tool chỉ đọc/tìm kiếm không bị NoIdle hỏi thêm.
- **Chọn đáp án:** với `vscode_askQuestions`, hook đọc tiêu đề, câu hỏi, thông tin bổ sung và các lựa chọn; nói số, tên, "tất cả" khi được chọn nhiều, hoặc câu tự do khi biểu mẫu cho phép. Nói huỷ, im lặng, câu phủ định/lưỡng lự hoặc biểu mẫu không hỗ trợ thì quay về hộp thoại. Chỉ trả kết quả sau khi nghe đủ tất cả câu hỏi. Hook chặn lần gọi tool hỏi và đưa đáp án vào lý do để agent tiếp tục, **không tự bấm lựa chọn trên giao diện**.

`PreToolUse` chạy trước khi gọi tool, không phải sự kiện hộp xin quyền: khi bật `voiceApprove`, Chat có thể hỏi cả lệnh vốn đã được tự cho phép. Quyết định từ các hook/chính sách khác vẫn có thể yêu cầu xác nhận hoặc chặn thao tác. Tắt `voiceApprove` để dừng hỏi duyệt bằng giọng, tắt `handsFree` để dừng nghe đáp án; mute thì không mở mic. Các phiên Agent Host dùng giao thức Copilot SDK được xử lý theo luồng CLI, phụ thuộc những sự kiện phiên bản VS Code đó hỗ trợ.

### GitHub Copilot CLI

Bật `noIdle.voiceResponse`, `noIdle.voiceNotify`, `noIdle.voiceApprove` và `noIdle.handsFree` để dùng cả đọc phản hồi, thông báo, approve/từ chối và trả lời câu hỏi bằng giọng. Mở `copilot` trong terminal tích hợp của VS Code, cùng workspace; khởi động lại CLI sau khi extension đồng bộ hook. Không phải GitHub CLI `gh`.

CLI đọc xong thì lời nói quay về **đúng terminal chạy CLI**, không mở ô Copilot Chat. Nếu CLI chạy ở terminal bên ngoài hoặc không xác định được terminal theo cây tiến trình, NoIdle không tự chèn vào terminal đang chọn để tránh chạy nhầm lệnh. Đọc thành tiếng vẫn hoạt động; nghe mic và làm nổi cửa sổ cần VS Code đang mở workspace tương ứng.

Hook dùng giao thức camelCase của CLI, nhưng vẫn nhận giao thức snake_case từ Chat. Nếu có `COPILOT_HOME` trong môi trường của VS Code, extension đồng bộ thêm file `hooks\noidle.json` trong thư mục đó; tắt `voiceResponse` gỡ cả hai file do extension quản lý.

CLI gọi `permissionRequest` **trước** bộ kiểm tra quyền của nó, nên có thể hỏi bằng giọng cho cả lệnh vốn được tự cho phép. NoIdle chỉ trả quyền sau khi nghe xác nhận rõ và lệnh vượt qua cùng danh sách an toàn của Claude; lời nói không rõ, tool lạ, file nhạy cảm hay yêu cầu thoát sandbox được để CLI xử lý thủ công. NoIdle không sửa quy tắc quyền của CLI.

Câu hỏi `ask_user` được đọc kèm lựa chọn; nói số, tên hoặc câu tự do nếu câu hỏi cho phép. Chỉ chọn nhiều khi biểu mẫu cho phép chọn nhiều. Giống hook Claude, NoIdle chặn lần gọi tool đặt câu hỏi và đưa câu trả lời vào lý do phản hồi để agent tiếp tục, **không giả lập thao tác chọn trên hộp thoại**. Biểu mẫu không hỗ trợ hoặc câu trả lời không rõ vẫn để chọn tay.

Hướng dẫn 🔊 được cung cấp qua `sessionStart`; CLI 1.0.56 còn nhận nhắc theo mỗi prompt qua `modifiedPrompt`. Các bản CLI bỏ qua output của `userPromptSubmitted` vẫn có hướng dẫn đầu phiên, nhưng cần mở phiên mới sau khi đổi ngôn ngữ/kiểu recap–announce để cập nhật hướng dẫn cho model. Mute, giọng đọc và việc bật/tắt mic vẫn được extension/hook đọc từ cấu hình.

### Giọng ElevenLabs (tuỳ chọn)

Muốn giọng tự nhiên hơn và đọc trộn Việt Anh mượt hơn Edge thì chuyển sang ElevenLabs. Gói Free của ElevenLabs có API và 10.000 credit mỗi tháng; model Flash v2.5 (mặc định) tính nửa credit một ký tự, tức khoảng 20.000 ký tự đọc, đủ thử hằng ngày với phần 🔊 ngắn.

1. Đăng ký tại [elevenlabs.io](https://elevenlabs.io), lấy key ở [Settings → API keys](https://elevenlabs.io/app/settings/api-keys).
2. Giọng mặc định là **George**, giọng có sẵn của ElevenLabs, đọc trộn Việt Anh trong một câu (tiếng Việt hơi ngữ điệu Tây). Giọng có sẵn khác dán vào `noIdle.elevenLabsVoiceId`: Liam `TX3LPaxmHKxFdv7VOQHJ`, Daniel `onwK4e9ZLuTAKqWW03F9`, Charlie `IKne3meq5aSn8XLyUdCD`, Sarah `EXAVITQu4vr4xnSDxMaL`. Giọng Việt trong [Voice Library](https://elevenlabs.io/app/voice-library) như Nhật Phong (`6adFm46eyy74snVn6YrT`) chỉ gọi được qua API từ gói Starter (5 USD/tháng): gói Free trả lỗi 402 "Free users cannot use library voices via the API" và hook lùi về Edge. Có Starter thì mở giọng trong thư viện, Add to my voices, copy Voice ID dán vào setting.
3. Chạy `NoIdle: Set ElevenLabs API Key`, dán key. Lệnh này lưu key và chuyển `noIdle.ttsProvider` sang `elevenlabs` luôn. Chạy `NoIdle: Đọc thử giọng` để nghe.

Hook đọc key từ file cấu hình riêng của extension, không đưa lên dòng lệnh hook. ElevenLabs không bị mở yêu cầu song song như Edge (mỗi ký tự là credit), chỉ thử lại một lần khi lỗi; vẫn lỗi (key sai, hết credit, giọng thư viện trên gói Free, mất mạng) thì câu đó tự đọc bằng giọng Edge đang chọn và ghi lý do vào `hook.log`. Hết credit thì hook nhớ số liệu và đi thẳng Edge cho các câu sau, không gọi ElevenLabs lỗi lại mỗi câu; tới kỳ reset tháng (hoặc sau 24 giờ nếu không biết mốc) mới thử lại. `noIdle.voiceRate` vẫn áp dụng, đổi sang speed 0.7 đến 1.2 của ElevenLabs. Sau mỗi lượt đọc bằng ElevenLabs, hook hỏi số credit còn lại và extension hiện cạnh nút mic trên status bar, kiểu `6.4k/10k` (còn / hạn mức tháng), nền vàng khi còn dưới 10%; chỉ hiện, không đọc thành tiếng, và chỉ khi `ttsProvider` là `elevenlabs`. Script `tts-preview.py` chỉ đọc bằng Edge.

Giọng vi-VN đọc chữ viết tắt và đuôi file tiếng Anh sai, kiểu `README.md` thành "mờ đờ". Hook thay sẵn các thuật ngữ hay gặp bằng âm tiếng Việt trước khi đọc: `.md` thành "chấm em đi", `API` thành "ây pi ai", `JSON` thành "chây sơn", `CI/CD` thành "xi ai xi đi". Thêm từ của bạn hoặc sửa cách đọc mặc định bằng `noIdle.pronunciations`, ví dụ `{"Claude": "cờ lốt", "shipngo": "síp gô"}`; đổi là có hiệu lực ngay ở lượt sau. Bảng mặc định nằm trong `src/pronounce.ts`.

Để tiết kiệm token, hướng dẫn viết phần 🔊 chỉ được chèn đầy đủ ở prompt đầu tiên của mỗi phiên Claude Code (khoảng 400 token); các prompt sau chỉ chèn một dòng nhắc ngắn (khoảng 40 token), và cứ 20 prompt thì chèn lại bản đầy đủ một lần phòng khi context bị nén. Hook đếm theo `session_id` bằng file trong `noidle-tts/sessions` trong thư mục tạm.

Không muốn tốn token cho phần 🔊 thì đặt `noIdle.voiceStyle` là `announce`: hook không dặn Claude gì cả, trả lời xong chỉ đọc câu tiếng Anh "Workspace X is done" (hoặc "Workspace X is asking you" khi câu cuối là câu hỏi), bất kể ngôn ngữ của phiên. Bạn biết cửa sổ nào cần mình mà không nghe nội dung; approve và chọn đáp án bằng giọng vẫn chạy như thường vì vốn là câu cứng. Đổi kiểu giữa phiên cũng được: sang `announce` thì hook nhắc Claude một lần thôi viết phần 🔊 (hướng dẫn cũ còn trong lịch sử), quay lại `recap` thì chèn lại hướng dẫn đầy đủ.

Mở nhiều cửa sổ thì nghe tên chưa chắc tìm ra: khi Claude xong, cần approve hoặc cần trả lời mà cửa sổ đó không đang focus, nút của nó trên taskbar Windows nháy cam tới khi bạn bấm vào (`noIdle.attentionFlash`, gọi FlashWindowEx qua PowerShell; macOS không có taskbar và không cho làm nảy icon Dock từ ngoài, nên title bar nháy bốn lần thay thế) và title bar (màu `noIdle.attentionTintColor`, mặc định xanh lá) cùng nút NoIdle trên status bar của cửa sổ đó đổi màu với chữ "Claude xong" hay "cần approve", tự trả lại khi cửa sổ được focus (`noIdle.attentionColor`). Chỉ thanh trên đổi màu: VS Code mới lấy màu title bar làm nền chrome sau các phần, nên hook ghi thêm `modernUI.shellBackground` bằng màu gốc của theme để viền quanh editor, panel, sidebar không đổi theo. Title bar đổi màu bằng cách ghi `workbench.colorCustomizations` vào settings của workspace như Peacock rồi gỡ sau, nên workspace có `.vscode/settings.json` trong git sẽ thấy file đó đổi trong lúc đang tô. Cần `window.titleBarStyle` là `custom` (mặc định trên Windows và macOS) thì title bar mới nhận màu. Cả hai chạy kể cả khi đang mute.

Chạy nhiều workspace cùng lúc thì mỗi phần đọc mở đầu bằng "Workspace X:" để biết cửa sổ nào vừa xong (setting `noIdle.voiceSayWorkspace`, mặc định chỉ bật khi có hơn một cửa sổ VS Code). Đang nghe mà muốn bỏ qua thì bấm **F7** hoặc chạy `NoIdle: Bỏ qua đang đọc`: bản đang đọc bị cắt, bản kế tiếp phát tiếp, hands-free vẫn mở mic như thường.

Mọi thứ từ dòng 🔊 đến hết câu trả lời sẽ được đọc. Claude được dặn viết phần này đủ nghĩa để nghe xong không cần nhìn màn hình: hỏi thông tin thì kể đủ các mục chính, báo cáo việc đã làm thì hai ba câu. Muốn nghe kỹ hơn nữa thì nói "đọc chi tiết". Nếu Claude không thêm dòng 🔊, extension đọc khoảng 300 ký tự đầu của câu trả lời, bỏ code và markdown. Lỗi đọc được ghi tại `noidle-tts/hook.log` trong thư mục tạm.

### Đọc thử nhanh, không chờ hook

Mở `scripts/tts-preview.py`, thay nội dung biến `TEXT` đầu file bằng đoạn muốn nghe, rồi chạy:

```powershell
python scripts/tts-preview.py
```

Hoặc truyền một câu trực tiếp:

```powershell
python scripts/tts-preview.py "Bạn cập nhật extension rồi kiểm tra ShipNGo và Shippo nhé."
```

Script đọc lại Settings người dùng mỗi lần chạy, lấy `noIdle.voice`, `voiceRate`, `language`, `pronunciations` và đường dẫn player từ `ffmpegPath`. Dùng đúng bộ xử lý pronunciation của dự án, không gọi AI, không tự tách tên ghép và không thay cài đặt. Nó phát riêng, bỏ qua mute, hàng đợi và khóa mic của hook; nên dừng các lượt đọc/thu âm khác trước khi thử. Vẫn cần mạng để tổng hợp Edge TTS.

- `--file sample.txt`: đọc file UTF-8 thay cho `TEXT`.
- `--dry-run`: chỉ xem giọng và chữ sau pronunciation, không gọi mạng hoặc phát loa.
- `--voice en-US-BrianMultilingualNeural`: thử giọng khác trong một lượt.
- `--rate=+10%`, `--language vi`: đổi tạm tốc độ hoặc ngôn ngữ. Với `auto`, script đoán từ đoạn thử, không có lịch sử ngôn ngữ của phiên chat.
- `--settings "C:\duong-dan\settings.json"`: chọn Settings của profile VS Code khác. Mặc định dùng `%APPDATA%\Code\User\settings.json`, hỗ trợ comment và dấu phẩy cuối.

Cần Python 3, Node.js, ffplay và dependencies của repo (`npm install` nếu chưa có). Không cần cài gói Python; file Python gọi các thư viện Node có sẵn trong repo để tránh sai khác với extension. Giữ script trong repo khi chạy.

## Dùng tiếng Anh / English mode

Đặt `noIdle.language` thành `en`. Một setting này đổi cả chuỗi: Whisper nghe tiếng Anh, LLM sửa câu bằng prompt tiếng Anh, Claude và Copilot được dặn viết phần 🔊 bằng tiếng Anh, hook nói "Workspace abc needs approval" hay "After the beep, say approve or deny", và bảng phiên âm sang tiếng Việt được bỏ qua (bảng `noIdle.pronunciations` của bạn vẫn áp dụng). Nếu giọng đang là vi-VN thì extension tự dùng giọng đa ngôn ngữ Ava cho tiếng Anh; chọn giọng khác bằng `noIdle.voice` (có thêm Christopher, Aria, Jenny, Guy, Sonia, Ryan, Natasha chỉ nói tiếng Anh). Lệnh nói vẫn nhận cả hai thứ tiếng: approve, ok, yes, deny, no, send, cancel, stop, never mind, skip, all, one đến nine.

Muốn khỏi bật tắt tay thì đặt `auto`: hook nhìn prompt bạn vừa gửi, có dấu tiếng Việt hoặc từ tiếng Việt quen thuộc thì tiếng Việt, câu ASCII từ ba từ trở lên thì tiếng Anh, ngắn quá kiểu "ok" thì giữ ngôn ngữ của lượt trước trong cùng phiên. Đổi ngôn ngữ giữa phiên thì hook chèn lại hướng dẫn đầy đủ để Claude đổi theo ngay lượt đó, không cần restart. Câu báo approve, chọn đáp án và giọng đọc đi theo ngôn ngữ đã nhớ của phiên đó; phiên mới chưa biết gì thì tiếng Việt. Phía mic, `auto` để Whisper tự nhận diện và chọn prompt sửa câu theo ngôn ngữ Whisper trả về; lưu ý nói tiếng Việt trộn nhiều thuật ngữ tiếng Anh thì Whisper đôi khi đoán nhầm sang tiếng Anh và dịch cả câu, nên dev Việt nên để `vi` nếu gặp chuyện đó.

Set `noIdle.language` to `en` and the whole chain switches: Whisper listens for English, the LLM cleanup uses an English prompt, Claude and Copilot are told to write the 🔊 section in English, the hook speaks English ("Workspace abc needs approval", "After the beep, say approve or deny"), and the Vietnamese pronunciation table is skipped (your own `noIdle.pronunciations` still apply). A vi-VN voice is swapped for the multilingual Ava voice; pick another with `noIdle.voice` (William is a further multilingual voice with an Australian accent; Christopher, Aria, Jenny, Guy, Sonia, Ryan and Natasha are English-only additions). Spoken commands work in both languages: approve, ok, yes, deny, no, send, cancel, stop, never mind, skip, all, one to nine. With `auto`, the hook reads the language off each prompt you send (Vietnamese diacritics or common words → Vietnamese, plain ASCII of three words or more → English, too short → keep the session's last language), re-injects the full instructions whenever the language flips so Claude switches in that very turn, and the mic lets Whisper auto-detect. VS Code messages and this README are still Vietnamese for now.

## Mic tự mở khi nào

**Mic tự mở khi nào?** Chỉ ba lúc: Claude đọc xong câu trả lời và lúc Claude hỏi chọn đáp án (cả hai do `noIdle.handsFree`), và lúc Claude xin quyền chạy lệnh (`noIdle.voiceApprove`). Tắt hai setting này là mic không bao giờ tự mở, chỉ mở khi bạn bấm F6. Trong Settings, các setting được chia năm nhóm: Đọc câu trả lời, Mic tự mở, Báo cửa sổ đang cần bạn, Giọng đọc, Nói để gõ.

## Phím tắt

Phím tắt mặc định là **F6**. Đổi phím trong `File > Preferences > Keyboard Shortcuts`, tìm `noIdle.toggle`. Lần đầu chạy, extension tự thêm `noIdle.toggle` vào `terminal.integrated.commandsToSkipShell` để phím tắt hoạt động trong terminal.

## Nói để gõ (F6): chữ vào đâu

Chữ được chèn theo nơi đang focus:

| Đang focus | Kết quả |
|---|---|
| Editor | Chèn tại con trỏ của editor đang mở lúc bấm F6, gõ từng ký tự; đổi focus giữa chừng chữ vẫn vào editor đó. |
| Terminal | Gửi vào terminal đang mở. |
| Ô chat Copilot | Đặt cả câu vào ô chat bằng lệnh mở chat của VS Code (không gửi), nên không phụ thuộc ô chat có đang focus; mỗi cụm mới thay cả nội dung ô chat bằng transcript tới lúc đó. |
| Nơi khác | Copy vào clipboard và báo để bạn tự dán. |

Thuật ngữ lập trình tiếng Anh như `refactor`, `commit`, `pull request`, `unit test` được giữ nguyên, không bị dịch sang tiếng Việt.

Mỗi cụm sau khi nhận dạng được gửi thêm một lượt qua LLM trên Groq để sửa chính tả, dấu thanh, dấu câu và viết hoa. Bước này tốn thêm khoảng một giây mỗi cụm. Tắt bằng setting `noIdle.refine` nếu muốn chữ ra ngay.

## Scope setting và mic dùng chung giữa các cửa sổ

Các setting của NoIdle khai báo scope `application` (đường dẫn ffmpeg và micro là `machine`), nên VS Code không cho đặt riêng theo workspace; hook đọc một file cấu hình chung cho mọi cửa sổ.

Mic dùng chung giữa các cửa sổ VS Code, giữ bằng một khoá tạo kiểu độc quyền nên hai cửa sổ xin cùng lúc chỉ một cửa sổ được. Một cửa sổ đang nghe (F6, hands-free, hay đang chờ approve) thì cửa sổ khác không tự mở mic hands-free hay hỏi approve bằng giọng; bấm F6 tay ở cửa sổ khác thì cửa sổ đang nghe (kể cả đang nghe approve) được bảo tắt mic, F6 chờ nó trả khoá tối đa 2,5 giây rồi mới mở; nó không trả thì báo "cửa sổ khác đang nghe" và không mở. Trong lúc mic đang mở, loa của mọi phiên không phát; chờ tới khi mic tắt (khoá mic tự hết hạn sau 5 phút), quá thì bỏ lượt đọc đó thay vì phát chen. Ngược lại, bấm F6 lúc loa đang đọc thì lượt đọc đó bị cắt để mic không thu tiếng loa; nghe approve hay chọn đáp án cũng cắt như vậy, vì giữa lúc câu báo đọc xong và lúc extension giữ được mic, một câu của phiên khác có thể vừa bắt đầu phát. Huỷ lượt nghe approve lúc mic còn đang khởi động thì extension đợi khởi động xong, tắt mic, rồi mới trả khoá cho cửa sổ khác. Mỗi phiên nói chốt terminal từ lúc mở mic, kể cả khi bấm "Gửi lại" sau lỗi mạng: bạn đổi sang terminal khác giữa chừng thì chữ và Enter vẫn vào terminal ban đầu. Một cửa sổ có nhiều terminal thì hands-free vẫn gõ vào terminal đang chạy phiên Claude vừa đọc xong (so pid shell với cây tiến trình của Claude); Claude chạy ở terminal ngoài VS Code thì không có terminal nào khớp và hands-free bỏ qua.
