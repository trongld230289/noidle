# Bước hai: tự Enter và tín hiệu ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hands-free tự gửi khi ngắt hơi; approve và chọn đáp án nghe qua mic của extension; hook không mở mic nữa.

**Architecture:** Khung tin trên pipe đổi sang dòng kết thúc `\n`, server trả lời được (`ask` → `{heard}`). Extension thêm một chế độ nghe một cụm (`askOnce`) dùng chung Recorder và Segmenter, và hẹn giờ tự gửi trong session hands-free. Hook thay `listenAndTranscribe` bằng `askWindow`, xoá listen.ts.

**Tech Stack:** TypeScript, Node net, vitest, VS Code API.

**Spec:** docs/superpowers/specs/2026-09-11-step-two-auto-send-and-ask-design.md

## Global Constraints

- Hook không tự mở mic ở bất kỳ đường nào sau bước này.
- Tự gửi chỉ khi tổng chữ đã chèn có từ 3 từ trở lên.
- Mọi chuỗi hiển thị và comment bằng tiếng Việt.

---

### Task 1: parseVoiceCommand (decision.ts)

**Files:** Modify `src/decision.ts`; Test `test/decision.test.ts`.

**Interfaces:** Produces `parseVoiceCommand(raw: string): { command?: 'send' | 'cancel'; text: string }`.

- [ ] Test:

```ts
describe('parseVoiceCommand', () => {
  it('gửi ở cuối câu: bỏ từ đó, lệnh send', () => {
    expect(parseVoiceCommand('sửa lỗi này gửi')).toEqual({ command: 'send', text: 'sửa lỗi này' });
    expect(parseVoiceCommand('Gửi đi.')).toEqual({ command: 'send', text: '' });
    expect(parseVoiceCommand('chạy test, send')).toEqual({ command: 'send', text: 'chạy test' });
  });
  it('chỉ một từ huỷ/thôi/dừng: lệnh cancel', () => {
    for (const w of ['huỷ', 'Hủy.', 'thôi', 'bỏ', 'dừng', 'xong']) expect(parseVoiceCommand(w).command).toBe('cancel');
  });
  it('câu thường: không lệnh, giữ nguyên chữ', () => {
    expect(parseVoiceCommand('gửi email cho khách')).toEqual({ text: 'gửi email cho khách' });
    expect(parseVoiceCommand('thôi không cần refactor')).toEqual({ text: 'thôi không cần refactor' });
  });
});
```

- [ ] Implement:

```ts
export interface VoiceCommand { command?: 'send' | 'cancel'; text: string; }
/** Lệnh nói trong hands-free: "gửi"/"send" ở cuối cụm thì gửi ngay; cụm chỉ là "huỷ", "thôi"... thì tắt mic không gửi. */
export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = raw.trim();
  if (/^(huỷ|hủy|huy|thôi|thoi|bỏ|bo|dừng|dung|xong)[\s.!]*$/iu.test(text)) return { command: 'cancel', text: '' };
  const m = /^(.*?)[\s,.]*\b(gửi đi|gửi|gui di|gui|send)[\s.!]*$/iu.exec(text);
  if (m) return { command: 'send', text: m[1].trim() };
  return { text };
}
```

Lưu ý `\b` không hoạt động với chữ có dấu trong JS; dùng `(?:^|\s)` thay `\b`.

- [ ] `npx vitest run test/decision.test.ts` PASS. Commit `feat(decision): parseVoiceCommand`.

---

### Task 2: signal.ts, khung dòng và `ask` có trả lời

**Files:** Modify `src/signal.ts`; Test `test/signal.test.ts`.

**Interfaces:**
- `Signal` thêm `event: 'ask'` và `timeoutSec?: number`.
- `startServer(pipe, handler: (s: Signal) => void | Promise<string | void>)`: handler trả string thì server ghi `{heard}` + `\n` rồi end; ngược lại end ngay sau khi nhận dòng.
- `askSignal(pipe, signal, timeoutMs): Promise<string | undefined>`: gửi dòng, chờ dòng trả lời, undefined nếu lỗi/hết giờ.
- `askWindow(signal, dir?, log?): Promise<string | undefined>`.

- [ ] Test:

```ts
it('ask: server trả lời heard', async () => {
  const pipe = testPipe();
  const server = startServer(pipe, async (s) => (s.event === 'ask' ? `nghe ${s.timeoutSec}` : undefined));
  await new Promise((r) => server.once('listening', r));
  expect(await askSignal(pipe, { event: 'ask', session: '', cwd: 'D:/x', timeoutSec: 7 }, 2000)).toBe('nghe 7');
  expect(await askSignal(testPipe(), { event: 'ask', session: '', cwd: 'D:/x' }, 500)).toBeUndefined();
  server.close();
});
```

- [ ] Implement: server buffer, tách theo `\n`, mỗi dòng parse → `Promise.resolve(handler(s)).then(reply => { if (typeof reply === 'string') socket.write(JSON.stringify({heard: reply}) + '\n'); socket.end(); })`. `sendSignal` giữ nguyên hành vi (client end sau khi ghi, chờ close). `askSignal`: connect, write (không end), gom data tới `\n`, parse `{heard}`, resolve, destroy; timeout → undefined.
- [ ] Tests PASS. Commit `feat(signal): line framing, ask with reply`.

---

### Task 3: Hook dùng askWindow, xoá mic

**Files:** Modify `src/hook.ts`; Delete `src/listen.ts`; Modify `src/extension.ts` (writeHookConfig).

- [ ] Trong hook: xoá `beep`, `listenAndTranscribe`, `modeListen`, import `listenOnce`, `transcribe`. `HookConfig` còn `voiceApprove`, `approveTimeoutSec`, `handsFree`. Thêm

```ts
/** Nhờ extension mở mic nghe một câu; trả '' nếu không có cửa sổ, im lặng hoặc lỗi. */
async function askHeard(cwd: string, session: string, timeoutSec: number, label: string): Promise<string> {
  const t0 = Date.now();
  const heard = (await askWindow({ event: 'ask', session, cwd, timeoutSec }, undefined, log)) ?? '';
  log(`${label}: nghe ${JSON.stringify(heard)} (${Date.now() - t0}ms)`);
  return heard.trim();
}
```

`voiceApprove`/`voiceChoose` gọi `askHeard(input.cwd || process.cwd(), session, maxSec, ...)`. Điều kiện trong modeNotify bỏ `&& cfg.apiKey`. Timeout ask client = `(timeoutSec + 20) * 1000` (chờ cả Whisper).
- [ ] `writeHookConfig` trong extension chỉ ghi 3 trường. README bỏ câu "extension ghi key Groq ... vào hook-config.json".
- [ ] `npm run typecheck && npm test && npm run build`. Commit `feat(hook): approve and choice listen through the extension; hook no longer opens the mic`.

---

### Task 4: Extension, askOnce và tự Enter

**Files:** Modify `src/extension.ts`, `package.json` (2 setting), `README.md`.

- [ ] `config()` thêm `handsFreeAutoSend` (bool, true) và `handsFreeSendDelaySec` (number, 2.5). package.json khai báo.
- [ ] `askOnce(timeoutMs)`: xem spec phần B. Dùng `recorder.start`, `Segmenter({sampleRate, silenceMs: 1200, maxSegmentMs: timeoutMs, minSpeechMs: 180})`, cụm đầu → `pcmToWav` → `recorder.stop()` → `transcribe`. Cờ `asking` chặn `toggle` và `listen`.
- [ ] `onSignal` xử lý `ask`: `return askOnce(sec*1000)` (trả string).
- [ ] Tự gửi: `deliverSegment` nhận thêm `s?: Session`; sau transcribe nếu `s?.auto` thì `parseVoiceCommand(raw)`: cancel → `finishAuto(s, false)`, trả ''; send → chèn phần còn lại rồi `finishAuto(s, true)`; không lệnh → chèn, rồi `armSend(s)`.

```ts
  const AUTO_SEND_MIN_WORDS = 3;
  function armSend(s: Session): void {
    clearTimeout(s.sendTimer);
    if (!config().handsFreeAutoSend) return;
    s.sendTimer = setTimeout(() => {
      if (session !== s) return;
      const words = s.transcript.trim().split(/\s+/).filter(Boolean).length;
      if (words < AUTO_SEND_MIN_WORDS) return;
      void finishAuto(s, true);
    }, Math.max(0.5, config().handsFreeSendDelaySec) * 1000);
  }
  /** Kết thúc session hands-free: tắt mic, chờ chữ chèn xong, gửi Enter nếu send. */
  async function finishAuto(s: Session, send: boolean): Promise<void> {
    if (session !== s) return;
    s.sending = true; // cụm flush cuối không được hẹn giờ lại
    await toggle();
    await lastQueue;
    if (send) {
      vscode.window.activeTerminal?.sendText('', true);
      log('hands-free: đã gửi Enter');
    }
  }
```

Trong `enqueue`: `armIdle` như cũ và `clearTimeout(s.sendTimer)` (có cụm mới thì chưa gửi). Trong nhánh dừng của `toggle`: `clearTimeout(s.sendTimer)`.
- [ ] `npm run typecheck && npm test && npm run build`. Commit `feat(extension): auto-send after silence, voice send/cancel, askOnce for approve and choice`.

---

### Task 5: Docs, version 1.7.0, đóng gói

- [ ] package.json version 1.7.0; mô tả `viVoice.handsFree` bỏ "(bản sau sẽ tự Enter)", nói: ngắt hơi khoảng 2.5 giây là tự gửi, nói "gửi" để gửi ngay, "huỷ" để tắt mic không gửi. README mục Hands-free và Approve cập nhật: nghe qua mic của extension, status bar hiện, không cần key trong hook-config.
- [ ] `npm run package && code --install-extension vi-voice-1.7.0.vsix --force`. Commit `feat: hands-free auto-send and extension-owned approve/choice mic; release 1.7.0`.
