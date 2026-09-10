# Extension giữ mic (bước một) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lượt "Claude xong, chờ lệnh tiếp" mở đúng mic của F6 trong extension; hook Stop thoát ngay và chỉ gửi tín hiệu.

**Architecture:** Extension mỗi cửa sổ mở một named-pipe server và ghi file đăng ký (pid, pipe, workspace folders). Tiến trình `play` của hook phát xong thì tìm cửa sổ theo cwd và gửi một dòng JSON `listen`; hook `prompt` gửi `submitted`. Extension nhận `listen` thì bíp và bật session ghi âm tự động (target terminal), tự tắt khi im lặng, khi `submitted`, hoặc khi bấm F6.

**Tech Stack:** TypeScript, Node `net` (named pipe / unix socket), vitest, esbuild, VS Code API.

**Spec:** docs/superpowers/specs/2026-09-11-extension-owned-mic-design.md

## Global Constraints

- Hook không được làm Claude Code chậm: mọi tín hiệu có timeout ngắn (1500 ms), lỗi thì bỏ qua.
- Mic chỉ mở sau khi loa phát xong: tín hiệu `listen` phát từ tiến trình `play`, không từ hook Stop.
- Approve bằng giọng và chọn đáp án giữ nguyên code 1.5 (bước hai mới gom).
- Comment và chuỗi hiển thị bằng tiếng Việt như code hiện có.

---

### Task 1: signal.ts, hàm thuần và registry

**Files:**
- Create: `src/signal.ts`
- Test: `test/signal.test.ts`

**Interfaces:**
- Produces: `WindowEntry {pid, pipe, folders}`, `Signal = {event:'listen'|'submitted', session, cwd}`, `pickWindow(entries, cwd, caseInsensitive?)`, `parseSignal(line)`, `readRegistry(dir?)`, `writeRegistry(entry, dir?)`, `removeRegistry(pid, dir?)`, `pipeName(pid)`, `WINDOWS_DIR`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/signal.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickWindow, parseSignal, readRegistry, writeRegistry, removeRegistry, WindowEntry } from '../src/signal';

const w = (pid: number, ...folders: string[]): WindowEntry => ({ pid, pipe: `p${pid}`, folders });

describe('pickWindow', () => {
  it('chọn folder là tiền tố dài nhất của cwd', () => {
    const a = w(1, 'D:/Project');
    const b = w(2, 'D:/Project/vi-voice');
    expect(pickWindow([a, b], 'D:/Project/vi-voice/src', true)?.pid).toBe(2);
    expect(pickWindow([a, b], 'D:/Project/other', true)?.pid).toBe(1);
  });
  it('không phân biệt hoa thường và dấu gạch khi caseInsensitive', () => {
    expect(pickWindow([w(1, 'd:\\project\\vi-voice')], 'D:/PROJECT/VI-VOICE', true)?.pid).toBe(1);
    expect(pickWindow([w(1, '/home/a')], '/home/A', false)).toBeUndefined();
  });
  it('tiền tố phải đúng ranh giới thư mục', () => {
    expect(pickWindow([w(1, 'D:/a/b')], 'D:/a/bc', true)).toBeUndefined();
  });
  it('không khớp thì undefined', () => {
    expect(pickWindow([w(1, 'D:/x')], 'E:/y', true)).toBeUndefined();
    expect(pickWindow([], 'E:/y', true)).toBeUndefined();
  });
});

describe('parseSignal', () => {
  it('đọc dòng JSON hợp lệ', () => {
    expect(parseSignal('{"event":"listen","session":"s","cwd":"D:/x"}\n')).toEqual({ event: 'listen', session: 's', cwd: 'D:/x' });
  });
  it('bỏ JSON hỏng, event lạ, thiếu cwd', () => {
    expect(parseSignal('{')).toBeUndefined();
    expect(parseSignal('{"event":"boom","session":"","cwd":"x"}')).toBeUndefined();
    expect(parseSignal('{"event":"listen","session":""}')).toBeUndefined();
  });
});

describe('registry', () => {
  it('ghi, đọc, xoá entry; bỏ file hỏng', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-voice-reg-'));
    writeRegistry(w(11, 'D:/a'), dir);
    writeRegistry(w(12, 'D:/b'), dir);
    fs.writeFileSync(path.join(dir, '13.json'), '{oops', 'utf8');
    expect(readRegistry(dir).map((e) => e.pid).sort()).toEqual([11, 12]);
    removeRegistry(11, dir);
    expect(readRegistry(dir).map((e) => e.pid)).toEqual([12]);
    expect(readRegistry(path.join(dir, 'missing'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/signal.test.ts`
Expected: FAIL, cannot resolve `../src/signal`.

- [ ] **Step 3: Implement**

```ts
// src/signal.ts
/**
 * Kênh tín hiệu hook → extension. Mỗi cửa sổ VS Code mở một server trên named pipe và ghi một
 * file đăng ký (pid, pipe, workspace folders) vào WINDOWS_DIR. Hook tìm cửa sổ theo cwd rồi gửi
 * một dòng JSON: listen (mở mic nghe lệnh tiếp) hoặc submitted (người dùng đã gửi prompt).
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface WindowEntry {
  pid: number;
  pipe: string;
  folders: string[];
}

export type SignalEvent = 'listen' | 'submitted';
export interface Signal {
  event: SignalEvent;
  session: string;
  cwd: string;
}

export const WINDOWS_DIR = path.join(os.tmpdir(), 'vi-voice-tts', 'windows');

export function pipeName(pid: number): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\vi-voice-${pid}` : path.join(os.tmpdir(), `vi-voice-${pid}.sock`);
}

function normPath(p: string, caseInsensitive: boolean): string {
  const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? s.toLowerCase() : s;
}

/** Cửa sổ có workspace folder là tiền tố dài nhất của cwd (đúng ranh giới thư mục). */
export function pickWindow(entries: WindowEntry[], cwd: string, caseInsensitive = process.platform === 'win32'): WindowEntry | undefined {
  const target = normPath(cwd, caseInsensitive);
  let best: WindowEntry | undefined;
  let bestLen = -1;
  for (const e of entries) {
    for (const f of e.folders) {
      const folder = normPath(f, caseInsensitive);
      if (!folder) continue;
      const hit = target === folder || target.startsWith(folder + '/');
      if (hit && folder.length > bestLen) {
        best = e;
        bestLen = folder.length;
      }
    }
  }
  return best;
}

export function parseSignal(line: string): Signal | undefined {
  try {
    const o = JSON.parse(line.trim()) as Partial<Signal>;
    if ((o.event !== 'listen' && o.event !== 'submitted') || typeof o.cwd !== 'string') return undefined;
    return { event: o.event, session: typeof o.session === 'string' ? o.session : '', cwd: o.cwd };
  } catch {
    return undefined;
  }
}

export function readRegistry(dir = WINDOWS_DIR): WindowEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: WindowEntry[] = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as WindowEntry;
      if (typeof e.pid === 'number' && typeof e.pipe === 'string' && Array.isArray(e.folders)) out.push(e);
    } catch {
      /* file hỏng, bỏ */
    }
  }
  return out;
}

export function writeRegistry(entry: WindowEntry, dir = WINDOWS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  return file;
}

export function removeRegistry(pid: number, dir = WINDOWS_DIR): void {
  try {
    fs.unlinkSync(path.join(dir, `${pid}.json`));
  } catch {
    /* đã mất */
  }
}
```

(`net` được import sẵn cho Task 2.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/signal.test.ts`
Expected: PASS (3 describe, 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/signal.ts test/signal.test.ts
git commit -m "feat(signal): window registry, pickWindow, parseSignal"
```

---

### Task 2: signal.ts, server và client

**Files:**
- Modify: `src/signal.ts`
- Test: `test/signal.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `startServer(pipe, onSignal): net.Server`, `sendSignal(pipe, signal, timeoutMs?): Promise<boolean>`, `signalWindow(signal, dir?, log?): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** (thêm vào `test/signal.test.ts`)

```ts
import { startServer, sendSignal, signalWindow, pipeName } from '../src/signal';

const testPipe = () => pipeName(process.pid * 1000 + Math.floor(Math.random() * 1000));

describe('server/client', () => {
  it('gửi một dòng JSON qua pipe và nhận được', async () => {
    const pipe = testPipe();
    const got: unknown[] = [];
    const server = startServer(pipe, (s) => got.push(s));
    await new Promise((r) => server.once('listening', r));
    expect(await sendSignal(pipe, { event: 'listen', session: 's1', cwd: 'D:/x' })).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([{ event: 'listen', session: 's1', cwd: 'D:/x' }]);
    server.close();
  });
  it('pipe chết thì trả false, không ném', async () => {
    expect(await sendSignal(testPipe(), { event: 'listen', session: '', cwd: 'x' }, 500)).toBe(false);
  });
  it('signalWindow chọn cửa sổ theo cwd và dọn entry chết', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-voice-sig-'));
    const pipe = testPipe();
    const got: unknown[] = [];
    const server = startServer(pipe, (s) => got.push(s));
    await new Promise((r) => server.once('listening', r));
    writeRegistry({ pid: 1, pipe, folders: ['D:/live'] }, dir);
    writeRegistry({ pid: 2, pipe: testPipe(), folders: ['D:/dead'] }, dir);
    expect(await signalWindow({ event: 'submitted', session: '', cwd: 'D:/live/sub' }, dir)).toBe(true);
    expect(await signalWindow({ event: 'submitted', session: '', cwd: 'D:/dead' }, dir)).toBe(false);
    expect(await signalWindow({ event: 'submitted', session: '', cwd: 'D:/none' }, dir)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.length).toBe(1);
    expect(readRegistry(dir).map((e) => e.pid)).toEqual([1]);
    server.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/signal.test.ts`
Expected: FAIL, `startServer` is not a function.

- [ ] **Step 3: Implement** (thêm vào cuối `src/signal.ts`)

```ts
/** Server nhận tín hiệu: mỗi kết nối gửi một dòng JSON rồi đóng. Lỗi socket được bỏ qua. */
export function startServer(pipe: string, onSignal: (s: Signal) => void): net.Server {
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(pipe);
    } catch {
      /* chưa có */
    }
  }
  const server = net.createServer((socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => (data += d));
    socket.on('error', () => undefined);
    socket.on('end', () => {
      for (const line of data.split('\n')) {
        const s = parseSignal(line);
        if (s) onSignal(s);
      }
    });
  });
  server.on('error', () => undefined);
  server.listen(pipe);
  return server;
}

/** Gửi một tín hiệu; true nếu bên kia nhận (đóng kết nối bình thường), false nếu lỗi hoặc hết giờ. */
export function sendSignal(pipe: string, signal: Signal, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const socket = net.connect(pipe, () => {
      socket.end(JSON.stringify(signal) + '\n');
    });
    socket.on('error', () => finish(false));
    socket.on('close', (hadError) => finish(!hadError));
  });
}

/** Tìm cửa sổ theo cwd trong registry và gửi tín hiệu. Cửa sổ không trả lời thì xoá entry. */
export async function signalWindow(signal: Signal, dir = WINDOWS_DIR, log?: (m: string) => void): Promise<boolean> {
  const entry = pickWindow(readRegistry(dir), signal.cwd);
  if (!entry) {
    log?.(`signal ${signal.event}: không có cửa sổ nào cho ${signal.cwd}`);
    return false;
  }
  const ok = await sendSignal(entry.pipe, signal);
  if (!ok) {
    log?.(`signal ${signal.event}: cửa sổ pid ${entry.pid} không trả lời, xoá đăng ký`);
    removeRegistry(entry.pid, dir);
  } else log?.(`signal ${signal.event} → cửa sổ pid ${entry.pid}`);
  return ok;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/signal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/signal.ts test/signal.test.ts
git commit -m "feat(signal): named-pipe server, sendSignal, signalWindow"
```

---

### Task 3: Hook gửi tín hiệu thay vì tự nghe

**Files:**
- Modify: `src/hook.ts` (modeSpeak, spawnPlay, modePlay, modePrompt; xoá handsFreeTurn)
- Modify: `src/claudeHooks.ts` (timeout Stop 300 → 60)
- Test: `test/speech.test.ts` (applyHooks timeout)

**Interfaces:**
- Consumes: `signalWindow` từ Task 2.
- Produces: `play` nhận `--listen <cwd>`; `speak` và `prompt` đọc `cwd` từ stdin.

- [ ] **Step 1: Test timeout Stop** (thêm vào describe `applyHooks` trong `test/speech.test.ts`)

```ts
  it('Stop hook không còn chờ mic nên timeout 60s', () => {
    const on = applyHooks({}, opts);
    expect(on.hooks!.Stop[0].hooks![0].timeout).toBe(60);
  });
```

Run: `npx vitest run test/speech.test.ts` → FAIL (300).

- [ ] **Step 2: claudeHooks.ts**

Thay `if (event === 'Stop') hook.timeout = 300;` và comment bằng:

```ts
      // Stop: đọc câu trả lời được tách sang tiến trình play, hook chỉ chờ tách xong; 60s là dư.
      if (event === 'Stop') hook.timeout = 60;
```

- [ ] **Step 3: hook.ts, modeSpeak**

Thay toàn bộ `modeSpeak` và `handsFreeTurn` bằng:

```ts
async function modeSpeak(): Promise<void> {
  const input = JSON.parse((await readStdin()) || '{}') as {
    transcript_path?: string;
    stop_hook_active?: boolean;
    session_id?: string;
    cwd?: string;
  };
  if (!input.transcript_path) return;
  // Một hook khác vừa chặn Stop và Claude làm tiếp: không đọc lại để khỏi lặp.
  if (input.stop_hook_active) return;
  const cfg = loadConfig();
  let transcript: string;
  try {
    transcript = fs.readFileSync(input.transcript_path, 'utf8');
  } catch (err) {
    log(`không đọc được transcript: ${(err as Error).message}`);
    return;
  }
  const text = pickSpeech(lastAssistantText(transcript));
  const session = input.session_id ?? '';
  // Hands-free: extension mở mic sau khi loa phát xong. Tiến trình play gửi tín hiệu listen khi xong;
  // không có gì để đọc thì gửi ngay từ đây.
  const listenCwd = cfg.handsFree ? input.cwd || process.cwd() : undefined;
  if (text) spawnPlay(text, 'speak', session, listenCwd);
  else if (listenCwd) await signalWindow({ event: 'listen', session, cwd: listenCwd }, undefined, log);
}
```

Thêm import: `import { signalWindow } from './signal';`. Xoá import `refine` nếu không còn dùng (kiểm tra bằng `grep -n refine src/hook.ts`).

- [ ] **Step 4: hook.ts, spawnPlay và modePlay**

```ts
/** Tách tiến trình phát rồi thoát ngay để Claude Code không phải chờ. listenCwd: phát xong thì báo extension mở mic. */
function spawnPlay(text: string, kind: Ticket['kind'], session: string, listenCwd?: string): void {
  ...
  args.push('--kind', kind, '--session', session || '-');
  if (listenCwd) args.push('--listen', listenCwd);
  ...
}
```

Cuối `modePlay`, sau khi unlink file:

```ts
  const listenCwd = arg('listen', '');
  if (listenCwd) await signalWindow({ event: 'listen', session: session === '-' ? '' : session, cwd: listenCwd }, undefined, log);
```

- [ ] **Step 5: hook.ts, modePrompt**

```ts
async function modePrompt(): Promise<void> {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_CONTEXT } }),
  );
  // Người dùng vừa gửi prompt: bảo extension tắt mic hands-free nếu đang mở. Không có cửa sổ thì thôi.
  const input = JSON.parse((await readStdin()) || '{}') as { session_id?: string; cwd?: string };
  const cwd = input.cwd || process.cwd();
  await signalWindow({ event: 'submitted', session: input.session_id ?? '', cwd }, undefined, log);
}
```

Cập nhật comment đầu file: `speak` "tách tiến trình play (hands-free: play xong báo extension mở mic) và thoát ngay"; `prompt` "in hướng dẫn 🔊 rồi báo extension người dùng đã gửi".

- [ ] **Step 6: Build, test**

Run: `npm run typecheck && npm test && npm run build:hook`
Expected: PASS, không lỗi type (nếu `refine`/`transcribe` còn dùng trong voiceChoose thì giữ import).

- [ ] **Step 7: Commit**

```bash
git add src/hook.ts src/claudeHooks.ts test/speech.test.ts
git commit -m "feat(hook): hands-free signals extension to listen instead of blocking Stop"
```

---

### Task 4: Extension nhận tín hiệu, session tự động

**Files:**
- Modify: `src/status.ts` (state `listening`)
- Modify: `src/extension.ts` (server, registry, session auto, idle timer, beep)

**Interfaces:**
- Consumes: `startServer`, `writeRegistry`, `removeRegistry`, `pipeName`, `Signal` từ Task 1–2.

- [ ] **Step 1: status.ts** thêm state:

```ts
export type State = 'idle' | 'recording' | 'listening' | 'transcribing';
...
      case 'listening':
        this.item.text = '$(record) Claude đang nghe…';
        this.item.tooltip = 'Nói yêu cầu tiếp theo rồi bấm Enter. F6 để tắt mic';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
```

- [ ] **Step 2: extension.ts, Session và toggle**

Thêm vào `interface Session`: `auto: boolean; idleTimer?: NodeJS.Timeout;`.

`toggle(args?: { target?: Target; auto?: boolean })`: khi tạo session đặt `auto: !!args?.auto`; sau `status.set('recording')` đổi thành `status.set(s.auto ? 'listening' : 'recording')`; gọi `armIdle(s)` nếu `s.auto`. Trong nhánh dừng, sau `clearTimeout(maxTimer)` thêm `clearTimeout(s.idleTimer)`.

```ts
  /** Session hands-free: im lặng quá handsFreeTimeoutSec kể từ lúc mở hoặc cụm cuối thì tự tắt mic. */
  function armIdle(s: Session): void {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (session === s) {
        log('hands-free: im lặng, tắt mic');
        void toggle();
      }
    }, Math.max(5, config().handsFreeTimeoutSec) * 1000);
  }
```

Trong `enqueue(s, pcm)`: đầu hàm thêm `if (s.auto) armIdle(s);`.

- [ ] **Step 3: extension.ts, beep và server**

```ts
  /** Bíp ngắn báo "nói đi" trước khi mở mic hands-free, cùng cách với hook. */
  function beep(): Promise<void> {
    return new Promise((resolve) => {
      const p = spawn(playerPath(), ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.18'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      p.on('error', () => resolve());
      p.on('exit', () => resolve());
    });
  }

  async function onSignal(s: Signal): Promise<void> {
    log(`tín hiệu ${s.event} (session ${s.session || '-'})`);
    if (s.event === 'submitted') {
      if (session?.auto) await toggle();
      return;
    }
    if (!config().handsFree) return;
    if (session) {
      log('hands-free: mic đang bật sẵn, bỏ qua');
      return;
    }
    if (!vscode.window.activeTerminal) {
      log('hands-free: không có terminal đang mở, bỏ qua');
      return;
    }
    await beep();
    await toggle({ target: 'terminal', auto: true });
  }

  const pipe = pipeName(process.pid);
  const server = startServer(pipe, (s) => void onSignal(s).catch((err) => log(`lỗi tín hiệu: ${(err as Error).message}`)));
  const registerWindow = () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    try {
      writeRegistry({ pid: process.pid, pipe, folders });
    } catch (err) {
      log(`không ghi được đăng ký cửa sổ: ${(err as Error).message}`);
    }
  };
  registerWindow();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(registerWindow),
    { dispose: () => { removeRegistry(process.pid); server.close(); } },
  );
```

Import: `import { startServer, writeRegistry, removeRegistry, pipeName, Signal } from './signal';`. Đặt khối server ở cuối `activate`.

- [ ] **Step 4: Build, typecheck, test**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/status.ts
git commit -m "feat(extension): listen server, hands-free auto session with idle timeout and beep"
```

---

### Task 5: Docs, version, đóng gói

**Files:**
- Modify: `package.json` (version 1.6.0, mô tả `viVoice.handsFree`, `viVoice.handsFreeTimeoutSec`)
- Modify: `README.md` (mục Hands-free)

- [ ] **Step 1: package.json**

`viVoice.handsFree` markdownDescription:

> Vòng lặp nói chuyện với Claude Code. Claude đọc xong câu trả lời thì extension bíp và mở mic ngay trong cửa sổ này: bạn nói yêu cầu tiếp theo, chữ hiện trong terminal, bấm Enter để gửi (bản sau sẽ tự Enter). Im lặng hết giờ hoặc bấm F6 thì mic tắt. Claude hỏi chọn đáp án thì đọc các lựa chọn và nghe bạn chọn bằng số hoặc tên.

`viVoice.handsFreeTimeoutSec` description: "Hands-free: mic mở mà im lặng bao nhiêu giây thì tự tắt."

Version `1.6.0`.

- [ ] **Step 2: README** mục "Hands-free" viết lại theo mô tả trên (bỏ "thôi/xong/dừng", thêm "Enter tay, F6 tắt").

- [ ] **Step 3: Package và cài**

Run: `npm run package && code --install-extension vi-voice-1.6.0.vsix --force`

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "feat: extension owns the hands-free mic, hook only signals; release 1.6.0"
```

Thử tay theo mục Kiểm thử trong spec sau khi reload VS Code.
