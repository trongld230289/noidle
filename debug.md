# Hướng dẫn lấy log NoIdle khi báo lỗi

Dùng khi người dùng nghe thông báo lặp, nghe "cần approve" nhưng không có hộp duyệt, không nghe câu trả lời hoặc nghi ngờ hook chạy sai phiên bản.

## Hai file cần lấy trên Windows

Áp dụng cho VS Code bản thường, chạy local trên Windows. Bấm **Win + R**, dán từng thư mục bên dưới và nhấn Enter:

| File cần lấy | Thư mục mở bằng Win + R | Nội dung |
|---|---|---|
| `hook.log` | `%TEMP%\noidle-tts` | Sự kiện hook, quyết định thông báo, tổng hợp và phát giọng, lỗi liên quan. |
| `noidle.log` | `%APPDATA%\Code\User\globalStorage\trongld232.noidle` | Khởi động extension, phiên bản, đăng ký cửa sổ, tín hiệu và hoạt động trong VS Code. |

Lấy log sớm sau khi gặp lỗi. `hook.log` nằm trong thư mục tạm, có thể bị hệ thống dọn.

Chỉ lấy hai file trên, không gửi toàn bộ thư mục. Nếu không tìm thấy, ghi rõ file nào thiếu; đừng tạo file log rỗng thay thế.

## Thông tin gửi kèm

- Thời điểm xảy ra lỗi, ngày và múi giờ; ví dụ `2026-09-29 13:30, UTC+7`.
- Mô tả thao tác và kết quả mong đợi/thực tế; ví dụ "đọc cần approve 6 lần, hộp thoại chỉ hiện 1 lần".
- Phiên bản NoIdle, VS Code, hệ điều hành và Copilot CLI hoặc Claude Code nếu đang dùng.
- Đang dùng Copilot CLI trong terminal, Copilot Chat hay Claude Code; terminal trong VS Code hay bên ngoài.
- Có mở nhiều cửa sổ/workspace không; trạng thái Voice Response, Voice Notify và Hands Free.
- Vừa cập nhật extension hoặc reload cửa sổ trước khi xảy ra lỗi không.

Ảnh hoặc video là tùy chọn, chỉ gửi khi đã che thông tin nhạy cảm.

## Riêng tư trước khi gửi

Log hiện tại **chưa được lọc thông tin riêng tư tự động**. Có thể chứa nội dung được đọc thành tiếng, lời nói đã nhận dạng, một phần prompt và đường dẫn cá nhân.

1. Tạo bản sao hai file để kiểm tra và che thông tin nhạy cảm trước khi gửi.
2. Xóa hoặc che key, token, nội dung nội bộ và thông tin cá nhân nếu có. Không gửi `hook-config.json`, toàn bộ settings, transcript, audio hoặc toàn bộ thư mục lưu trữ.
3. Giữ thời gian, loại sự kiện, thông báo lỗi và mã liên kết phiên/tiến trình nếu có thể. Nếu đổi tên workspace hoặc mã phiên để ẩn danh, thay nhất quán để còn đối chiếu.
4. Gửi qua kênh hỗ trợ riêng được thống nhất. Không đăng log thô lên issue công khai.

Nếu không thể chia sẻ toàn bộ log, gửi đoạn quanh thời điểm lỗi, gồm cả các dòng trước và sau. Ghi rõ đã lược bỏ hoặc che phần nào.

## Không tìm thấy log hoặc dùng môi trường khác

- Mở **View > Output**, chọn kênh **NoIdle**. Dòng khởi động cho biết phiên bản extension và đường dẫn `noidle.log` thực tế.
- Với lỗi giọng đọc, lệnh **NoIdle: Đọc thử giọng** hiện đường dẫn `hook.log` và phát một câu thử. Báo trước cho người dùng vì lệnh này có phát tiếng.
- VS Code Insiders, bản portable, macOS hoặc môi trường remote có thể dùng vị trí khác. Không áp dụng máy móc hai đường dẫn Windows ở trên; lấy đường dẫn thực tế từ cửa sổ đang gặp lỗi.
- Nếu hook chạy trên máy khác với extension, ghi rõ log được lấy từ máy nào. Không có log cũng là thông tin chẩn đoán cần giữ lại.

## Mẫu nhắn người dùng

> Bạn giúp mình lấy log ngay sau khi gặp lỗi nhé. Nếu dùng VS Code bản thường trên Windows, bấm Win + R, mở `%TEMP%\noidle-tts` và lấy `hook.log`; sau đó mở `%APPDATA%\Code\User\globalStorage\trongld232.noidle` và lấy `noidle.log`.
>
> Gửi kèm giờ xảy ra lỗi và múi giờ, phiên bản NoIdle, bạn dùng Copilot CLI/Chat hay Claude Code, cùng mô tả ngắn như "đọc 6 lần nhưng chỉ hiện hộp thoại 1 lần". Nếu thiếu file nào, báo mình biết.
>
> Trước khi gửi, vui lòng kiểm tra và che nội dung riêng tư vì log có thể chứa nội dung được đọc, lời nói đã nhận dạng và đường dẫn cá nhân. Chỉ gửi bản sao hai file đã kiểm tra qua kênh hỗ trợ riêng, không gửi cấu hình chứa key hoặc cả thư mục.

## Ghi chú khi phân tích

- Thời gian trong `hook.log` dùng ISO UTC với hậu tố `Z`; `noidle.log` hiện dùng giờ địa phương và không có ngày trên từng dòng. Cần ngày và múi giờ người dùng cung cấp để đối chiếu.
- Một `PermissionRequest` của Copilot CLI chưa chứng minh hộp thoại duyệt đã xuất hiện: hook này có thể chạy trước bước kiểm tra quyền của CLI.
- `Notification permission_prompt` cũng có thể đã hết hiệu lực khi bắt đầu phát. Hook đối chiếu `permission.requested` và `permission.completed` trong transcript CLI trước khi báo, sau khi nháy cửa sổ, sau khi chờ hàng đợi/mic và trước khi đưa âm thanh vào player. Dòng `dropping stale alert` nghĩa là yêu cầu đã kết thúc nên bỏ tiếng báo; nếu không đọc hoặc ghép được lifecycle, log ghi rõ và giữ hành vi cũ.
- Một câu hỏi thủ công có thể đi qua cả `PreToolUse AskUserQuestion` và `Notification elicitation_dialog`. Hai sự kiện không có nghĩa là hai câu hỏi.
- Đối chiếu sự kiện nhận vào với `notify → play pid` để biết có tạo nhiều lượt đọc không. Không kết luận chỉ dựa vào số dòng log sự kiện.
- Kiểm tra phiên bản lúc extension khởi động và bản hook thực tế. Pull source hoặc cài extension mới không đảm bảo các cửa sổ đang mở đã nạp bản mới.
- Bản sửa thông báo thủ công chỉ dùng tín hiệu hộp thoại thay vì suy đoán từ kiểm tra quyền. Nếu CLI không phát `permission_prompt`, hộp duyệt vẫn có thể hiện nhưng không có tiếng báo. Hands Free vẫn có thể chủ động hỏi duyệt lệnh an toàn trước bước kiểm tra quyền.
