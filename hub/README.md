# Vi Voice Hub

Một trang web gom mọi phiên Claude Code trên máy vào một chỗ, mở được trên PC hoặc điện thoại cùng mạng: thấy phiên nào
đang làm, phiên nào đang chờ approve hay chờ trả lời, phiên nào vừa xong và nói gì; từ đó xếp hàng việc kế tiếp, approve
hoặc từ chối, trả lời câu hỏi, và nghe câu trả lời bằng giọng của chính điện thoại.

Hub độc lập với extension Vi Voice: chỉ cần Node 20 và Claude Code, không import hay gọi gì của extension. Cài cả hai
thì chúng chạy song song, không biết nhau.

## Cài

```powershell
cd hub
npm install
npm run build
node dist/hub.js install --lan     # bỏ --lan nếu chỉ dùng trên máy này
```

`install` ghi cấu hình vào `~/.vi-voice/hub.json` (token ngẫu nhiên), thêm hook của hub vào `~/.claude/settings.json`
(có bản sao `.bak`), và in URL. Phiên Claude Code đang mở cần khởi động lại để nhận hook. Sự kiện đầu tiên sẽ tự tách
server chạy nền; muốn mở ngay thì `node dist/hub.js open`.

Tuỳ chọn: `--port 4319`, `--lang vi|en` (nhãn trên trang và câu trả lời gửi cho Claude), `--local` để tắt LAN.
Gỡ: `node dist/hub.js uninstall`. Xem tình trạng: `node dist/hub.js status`.

## Dùng

Mỗi phiên một thẻ, thẻ đang chờ nổi lên đầu và đổi màu: đỏ cần approve, cam cần trả lời, xanh đang làm, xám đã xong.

- **Xếp hàng**: gõ việc tiếp theo, bấm Xếp hàng. Lệnh chạy ngay khi phiên đó xong lượt hiện tại, trong chính terminal
  đang mở (hook Stop chặn Claude dừng và đưa lệnh vào). Phiên đang rảnh thì lệnh nằm chờ tới khi phiên có lượt mới, ví
  dụ bạn gõ gì đó trong terminal đó hoặc dùng Remote Control của Claude Code.
- **Approve / Từ chối**: chỉ có tác dụng khi trang đang mở (hook chờ tối đa `waitSec`, mặc định 90 giây, và chỉ chờ khi có
  người xem để người ngồi máy không bị hộp thoại chậm). Lệnh nguy hiểm (xoá đệ quy, git push, reset --hard, drop table,
  sudo, sửa file .env hay settings...) không approve được từ web, luôn phải bấm tay.
- **Trả lời câu hỏi**: bấm lựa chọn, hoặc gõ câu trả lời tự do.
- **Tự đọc**: bật công tắc 🔊, trang đọc câu 🔊 mới và câu báo chờ bằng giọng của trình duyệt trên thiết bị đang xem
  (điện thoại chọn giọng vi-VN hoặc en-US có sẵn). Nghe lại từng thẻ bằng nút Nghe lại. Đây là giọng của máy đang xem, không
  liên quan giọng đọc trên PC của extension.

## Bảo mật

Mọi đường dẫn nằm sau `/t/<token>/`; sai token trả 404. Ai có URL là xếp hàng lệnh và approve được vào Claude Code của
bạn, nên chỉ bật `--lan` trong mạng tin cậy. Server không chạy lệnh shell nào từ web, chỉ ghi file trong
`%TEMP%\vi-voice-hub\inbox` để hook đọc. Log ở `%TEMP%\vi-voice-hub\hub.log`. Server tự thoát sau 4 giờ không ai dùng.

## Giới hạn

- Chỉ Claude Code; Copilot Chat chưa có.
- Phiên đang rảnh không nhận lệnh ngay, chỉ xếp hàng.
- Câu hỏi nhiều phần (AskUserQuestion có nhiều câu) chỉ hiện và trả lời câu đầu; Claude sẽ hỏi lại các câu còn lại.
- Chưa thử tự động: tách server nền thật và mở trên điện thoại. Có test cho hộp thư, transcript, bộ lọc nguy hiểm, server
  HTTP, hook chạy bundle thật, install/uninstall.

## Phát triển

```powershell
npm test          # vitest
npm run typecheck
npm run build     # dist/hub.js, một file, không dependency runtime
```
