# Hub: một trang điều khiển cho mọi workspace (project độc lập)

Ngày: 2026-09-22. Trạng thái: chờ duyệt.

## Mục tiêu

Một trang web mở trên PC hoặc điện thoại cùng mạng LAN, thấy mọi phiên Claude Code ở mọi cửa sổ VS Code hay terminal
ngoài, và ra lệnh cho từng phiên từ đó. Trang này cố tình mỏng: mỗi phiên một thẻ, trả lời ba câu "phiên nào đang cần
mình", "nó vừa nói gì", "giao việc kế tiếp". Không hiện code, diff, file hay lịch sử hội thoại.

**Ràng buộc do người dùng đặt**: project riêng trong thư mục `hub/` của workspace này, có package.json, build và test
riêng, **hoàn toàn độc lập với extension Vi Voice**: không import code của extension, không gọi bundle của extension,
không dùng chung thư mục tạm, chạy được khi extension không cài. Extension giữ nguyên. Hub đăng ký hook của riêng nó
vào `~/.claude/settings.json`; nếu extension cũng cài thì hai bộ hook chạy song song, không biết nhau.

## Không làm

- Xem diff, mở file, cuộn lịch sử chat, sửa code (đã có VS Code, Claude Code web, Remote Control).
- Nhiều người dùng, tài khoản, HTTPS. Một token, mạng tin cậy.
- Sửa hay dùng extension. Hệ quả chấp nhận: phiên đang rảnh (không có lượt nào chạy) không nhận được lệnh ngay, chỉ
  xếp hàng; xem mục "Giới hạn".
- Tổng hợp giọng phía server (Edge TTS, ffplay). Nghe trong trang dùng giọng của trình duyệt trên thiết bị đang xem.

## Kiến trúc

```
Claude Code ──sự kiện──▶ hub hook (chạy ngắn) ──ghi──▶ %TEMP%\vi-voice-hub\inbox\<session>.json
                              │                                 ▲            │
                              │ lần đầu: tách                   │ đọc        │ theo dõi (fs.watch)
                              ▼                                 │            ▼
                      hub serve (tiến trình nền, giữ cổng) ◀──────── trang web (SSE) ◀── PC / điện thoại
                              │                                                    │
                              ├─ ghi inbox/<session>.decision.json ─▶ hub hook đang chờ   │ speechSynthesis
                              └─ ghi inbox/<session>.queue.json    ─▶ hub hook Stop chặn dừng kèm lệnh kế tiếp
```

Hook của extension (nếu có) và hook của hub chạy độc lập trên cùng sự kiện, không gọi nhau, không chia sẻ file.
Thư mục tạm của hub là `%TEMP%\vi-voice-hub`, tách khỏi `vi-voice-tts` của extension.

## Cấu trúc project `hub/`

```
hub/
  package.json        # name: vi-voice-hub, scripts: build (esbuild → dist/hub.js), test (vitest), typecheck
  tsconfig.json
  README.md
  src/
    main.ts           # CLI: install | uninstall | hook <event> | serve | open | status
    inbox.ts          # đọc/ghi hộp thư, decision, queue (thuần)
    hub.ts            # HTTP server + SSE + API (thuần, nhận thư mục và callback)
    page.ts           # HTML/CSS/JS của trang, một chuỗi
    settings.ts       # thêm/gỡ hook vào ~/.claude/settings.json với dấu riêng 'vi-voice-hub'
    config.ts         # ~/.vi-voice/hub.json: enabled, port, lan, token, waitSec, lang
    transcript.ts     # lấy phần 🔊 của lượt cuối từ transcript JSONL (viết riêng)
    danger.ts         # lệnh/file không cho approve từ web (viết riêng)
  test/
```

Không import gì từ `src/` của extension. `transcript.ts` tự cài: lấy entry assistant cuối trong JSONL (`type: assistant`,
`message.content` là chuỗi hoặc mảng block text), chọn phần từ dòng 🔊 đầu tiên đến hết, bỏ markdown; không có 🔊 thì lấy
khoảng 300 ký tự văn xuôi đầu. `workspace` là thư mục cuối của cwd. Runtime không phụ thuộc gói nào ngoài Node;
devDependencies: esbuild, vitest, typescript.

## Thành phần

### 1. Hộp thư (`inbox.ts`)

Mỗi phiên một file JSON, ghi đè mỗi sự kiện, ghi tạm rồi rename.

```ts
interface InboxEntry {
  session: string;
  cwd: string;
  workspace: string;
  state: 'working' | 'waiting_approve' | 'waiting_answer' | 'done';
  updatedAt: number;
  lastSpoken?: string;   // phần 🔊 cuối
  lastPrompt?: string;   // 200 ký tự đầu prompt cuối
  pending?: { kind: 'approve' | 'question'; toolName?: string; summary?: string; question?: string;
              options?: string[]; multiSelect?: boolean; dangerous?: boolean; since: number };
  queued?: string;       // lệnh đang xếp hàng, để trang hiện
}
```

| Sự kiện | state | ghi thêm |
|---|---|---|
| UserPromptSubmit (bỏ qua nếu có `agent_id`) | working | lastPrompt, xoá pending |
| Stop | done | lastSpoken |
| PermissionRequest | waiting_approve | pending approve, `dangerous` theo `danger.ts` |
| PreToolUse AskUserQuestion, Notification elicitation_dialog | waiting_answer | pending question |
| hook chờ xong (quyết định hoặc hết giờ) | working | xoá pending |

Phiên cũ hơn 12 giờ bị `readInbox` bỏ. `danger.ts`: rm đệ quy hay ép, `git push` / `reset --hard` / `clean` /
`checkout --` / `branch -D` kể cả có tuỳ chọn trước động từ, drop/truncate/delete from, format, shutdown, docker rm/prune,
kubectl/az/aws delete, sudo, npm/vsce publish; file `.env*`, khoá, `.npmrc`, `.ssh/`, `settings.json`, `appsettings*.json`.

### 2. Server nền (`hub.ts`, chế độ `serve`)

- Mọi lệnh `hook` gọi `ensureServe()`: đọc `hub.lock` (`{pid, port, at, lastClientAt}`); pid chết thì tách
  `node hub.js serve` detached rồi thoát ngay, không chờ.
- Cấu hình `~/.vi-voice/hub.json`: `{ enabled, port: 4319, lan: false, token, waitSec: 90, lang: 'vi' }`, tạo lần đầu bởi
  `install` với token 32 hex ngẫu nhiên. `lan: true` bind `0.0.0.0`, ngược lại `127.0.0.1`. `enabled: false` thì hook
  không tách server và không ghi gì.
- Mọi đường dẫn dưới `/t/<token>/`; sai token trả 404 trống.
- Tự thoát sau 4 giờ không request và không sự kiện hook. Ghi `hub.lock` mỗi phút, kèm `lastClientAt`.
- Endpoint: `GET /` trang; `GET /api/state` (waiting trước, cũ nhất trước; rồi working; rồi done mới nhất trước);
  `GET /api/events` SSE (fs.watch inbox, gộp 200ms, gửi lại state); `POST /api/send {session, text}` → ghi queue, trả
  `{queued: true}`; `POST /api/decide {session, decision: 'allow'|'deny'}` hoặc `{session, answer: string | number[]}`
  chỉ khi waiting (allow bị từ chối khi `dangerous`); `GET /api/ping` → `{ok, version, host}`.
  Không có endpoint âm thanh: nghe và bỏ qua xử lý trong trang bằng Web Speech API.
- Cổng bận: thử 5 cổng kế, ghi cổng thật vào `hub.lock`.

### 3. Hook của hub (`main.ts hook <event>`)

- Đăng ký bởi `install`: UserPromptSubmit, Stop (timeout 30), PermissionRequest (timeout 120), PreToolUse matcher
  AskUserQuestion (timeout 180), Notification matcher elicitation_dialog. Mỗi lệnh chứa dấu `vi-voice-hub` để
  `uninstall` gỡ đúng của mình, không đụng hook nào khác.
- **Stop**: ghi inbox done + lastSpoken. Có queue cho phiên thì in `{"decision":"block","reason":"<lệnh>"}` và ghi cờ
  `<session>.ours`; lượt Stop kế có `stop_hook_active: true` mà thấy cờ thì vẫn ghi lastSpoken rồi xoá cờ. Không in gì khác.
- **PermissionRequest / AskUserQuestion**: ghi pending. Chờ decision file chỉ khi có người xem (`lastClientAt` trong 60s),
  tối đa `waitSec`, poll 300ms. Có quyết định thì in đúng schema: PermissionRequest → `hookSpecificOutput.decision.behavior`
  (deny kèm `message`); AskUserQuestion → `hookSpecificOutput.permissionDecision: deny` với lý do chứa câu trả lời để
  Claude làm tiếp. `dangerous` chỉ nhận deny. Hết giờ hoặc không ai xem: không in gì, hộp thoại tay hiện như thường.
  Nếu extension cũng cài, hook của nó có thể trả trước bằng giọng; Claude Code gộp quyết định, deny thắng.

### 4. Trang web (`page.ts`)

HTML/CSS/JS thuần, mobile-first, một cột, không framework.

- Đầu trang: tên máy, số phiên đang chờ, công tắc **Tự đọc** (trang tự đọc câu 🔊 mới và câu báo chờ bằng
  `speechSynthesis` của thiết bị đang xem, chọn giọng vi-VN hoặc en-US có sẵn trên máy đó; đây là cách nghe trên điện
  thoại), nút dừng đọc, chấm trạng thái SSE.
- Mỗi thẻ: workspace chữ to, trạng thái màu (đỏ chờ approve, cam chờ trả lời, xanh đang làm, xám xong) và thời gian
  tương đối, câu 🔊 cuối, nút nghe lại (đọc tại trình duyệt).
  - Chờ approve: tool + lệnh rút gọn, Approve (mờ nếu nguy hiểm, kèm ghi chú "bấm tay trong VS Code") / Từ chối.
  - Chờ trả lời: các lựa chọn dạng nút; multiSelect chọn nhiều rồi Gửi; ô nhập tự do.
  - Mọi thẻ: ô nhập + nút **Xếp hàng**; thẻ `done` hiện ghi chú "chạy khi phiên có lượt mới". Sau khi gửi hiện xác nhận và
    dòng "đang xếp hàng: ...".
- Nhãn vi/en theo `hub.json.lang`.

## Giới hạn

- Phiên `done` (rảnh) nhận lệnh xếp hàng, chỉ chạy khi phiên đó có lượt mới (bạn gõ gì đó trong terminal đó, hoặc dùng
  Remote Control của Claude Code). Gửi ngay vào phiên rảnh cần một bên có API terminal (extension); ngoài phạm vi hub.
- Copilot Chat: chưa có. Có thể thêm sau bằng file `~/.copilot/hooks/vi-voice-hub.json` chỉ để ghi inbox.
- Giọng đọc trong trang là của trình duyệt/điện thoại, chất lượng tuỳ máy.

## Bảo mật

Token bắt buộc, sai trả 404; ai có URL là ra lệnh được nên README ghi rõ chỉ bật `lan` trong mạng tin cậy. Server không
chạy lệnh shell nào từ web, chỉ ghi file trong thư mục hộp thư. Lệnh nguy hiểm không approve được từ web.

## Xử lý lỗi

- Server không bind được cổng: ghi log, thử cổng kế tiếp tối đa 5 lần.
- Inbox hỏng: `readInbox` bỏ file lỗi.
- Hook đang chờ web mà server chết: hết `waitSec` thì trả như thường.
- Trang mất SSE: chấm đỏ, nối lại mỗi 3 giây, kéo lại `api/state`.

## Kiểm thử

- `inbox.test.ts`: chuyển trạng thái, gộp, bỏ file hỏng, lọc 12 giờ, decision/queue lấy là hết.
- `transcript.test.ts`: lấy đúng phần 🔊, fallback văn xuôi, bỏ markdown, workspace từ cwd.
- `danger.test.ts`: danh sách lệnh/file nguy hiểm và lệnh thường.
- `hub.test.ts`: `startHub` thật trên 127.0.0.1 cổng 0, thư mục tạm: sắp xếp, token sai 404, send → queue, decide chỉ khi
  waiting và không allow khi dangerous, SSE nhận khi inbox đổi, `lastClientAt` cập nhật.
- `hook.test.ts`: chạy `dist/hub.js hook <event>` thật với stdin giả và TEMP riêng: inbox đúng theo bảng; Stop có queue in
  `decision: block` và Stop kế vẫn ghi; PermissionRequest có decision file trả đúng schema; không ai xem thì trả trong
  dưới 1 giây; subagent bị bỏ qua; `enabled: false` không ghi gì.
- `settings.test.ts`: install/uninstall chỉ thêm/gỡ hook có dấu của hub, giữ nguyên mọi hook khác.

## Thứ tự làm

1. Khung project, inbox, transcript, hook ghi inbox, server + trang xem, `install`/`open`. Chạy được: thấy trạng thái mọi
   phiên trên điện thoại.
2. Xếp hàng lệnh qua Stop; tự đọc và nghe lại trong trang bằng Web Speech.
3. Approve và trả lời câu hỏi từ web, tự thoát sau 4 giờ, README của hub.

## Câu hỏi còn mở

- Claude Code gộp quyết định nhiều hook PermissionRequest thế nào khi một hook allow và hook kia không trả gì: giả định
  allow được áp dụng; kiểm chứng ở bước 3.
