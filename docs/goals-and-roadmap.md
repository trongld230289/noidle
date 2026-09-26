# NoIdle: mục tiêu và lộ trình

Ghi ngày 2026-09-23. Bản gốc nằm trong bộ nhớ dự án của Claude Code, chép sang đây để đi theo repo.

## Mục tiêu (lời của dev)

1. Dev làm nhiều cửa sổ VS Code, không biết cái nào xong. Claude hoặc Copilot trả lời bằng giọng nói thì biết liền.
2. Làm nhiều mỏi lưng, đi nằm một chút. Task dài quá, nằm có khi ngủ quên, task chờ mình là tèo luôn.
3. Đang nằm lười ngồi dậy, nói qua headphone để AI làm tiếp, nằm nghỉ tiếp.
4. Giúp dev nói nhiều hơn. Luồng suy nghĩ khi nói tốt hơn khi gõ, não nhạy hơn.
5. Giảm thời gian chờ và không bị lỡ nhịp: agent làm xong mà dev không biết là mất thời gian chết. Biết ngay bằng giọng
   nói, kèm việc kế tiếp cần làm, để bắt tay vào luôn.

## Lộ trình đã thống nhất (đáng làm nhất xếp trước, chưa làm cái nào)

1. **Chế độ nằm (away mode).** Bật bằng giọng, ví dụ "để tôi nghỉ". Khi bật, hook chèn vào prompt: tự quyết theo mặc định
   hợp lý, không hỏi, ghi lại các quyết định ở cuối. Approve chỉ nhắc lại hai lần cách nhau vài phút rồi thôi, không giữ
   task treo. Rẻ nhất và chặn đúng mục tiêu 2.
2. ~~**Nút tai nghe thay F6.**~~ Bỏ (2026-09-26): ít giá trị mà dễ loạn. Wake word ("mở mic đi") cũng đã thử và bỏ
   cùng ngày: bắt được 7/8 bằng VAD + ASR tiếng Việt offline nhưng thêm khoảng 47 MB.
3. **Hỏi tình hình bằng giọng.** Nói "tình hình sao" là hook đọc: workspace nào đang chạy, workspace nào chờ approve,
   workspace nào xong bao lâu rồi. Dữ liệu có sẵn trong registry cửa sổ và hàng đợi; hub/ (đang tạm dừng) đã hiện dạng
   trang web.
4. **Nhịp tim cho task dài.** Cứ 3 đến 5 phút Claude vẫn đang chạy thì đọc một câu ngắn "workspace X vẫn đang chạy test"
   (sự kiện PostToolUse, có tiết chế), im lặng lâu nghĩa là kẹt.

Làm sau:

- "Đọc kỹ hơn": nói câu đó là hook đọc toàn bộ câu trả lời cuối thay vì phần tóm tắt (bản đầy đủ đã lưu trong dấu phiên).
- Nói dài để nghĩ: chế độ không tự gửi, LLM gom thành prompt gọn, đọc lại cho duyệt rồi mới gửi.
- Gọi tên cửa sổ: "Shipping, chạy test" gửi prompt sang đúng cửa sổ từ bất kỳ đâu, đặt tên bằng giọng một lần.
- Đẩy thông báo ra điện thoại qua ntfy hoặc Telegram khi cần approve mà không ai trả lời.

## Nguyên tắc

Setting đang nhiều (21 cái tính đến 2026-09-23). Tính năng mới nên nằm sau một công tắc, không thêm nhiều nút.
