import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  pickWindow,
  parseSignal,
  readRegistry,
  writeRegistry,
  removeRegistry,
  startServer,
  sendSignal,
  signalWindow,
  pipeName,
  askSignal,
  askWindow,
  canAutoListen,
  WindowEntry,
  Signal,
  pruneRegistry,
  routeSignal,
} from '../src/signal';

const w = (pid: number, ...folders: string[]): WindowEntry => ({ pid, pipe: `p${pid}`, folders });

describe('canAutoListen', () => {
  const enabled = { voiceResponse: true, handsFree: true };

  it('checks the current setting for each microphone purpose', () => {
    expect(canAutoListen({ event: 'ask', reason: 'approve' }, enabled)).toBe(true);
    expect(canAutoListen({ event: 'ask', reason: 'approve' }, { ...enabled, handsFree: false })).toBe(false);
    expect(canAutoListen({ event: 'ask', reason: 'answer' }, enabled)).toBe(true);
    expect(canAutoListen({ event: 'ask', reason: 'answer' }, { ...enabled, handsFree: false })).toBe(false);
    expect(canAutoListen({ event: 'listen' }, { ...enabled, handsFree: false })).toBe(false);
    expect(canAutoListen({ event: 'listen' }, enabled)).toBe(true);
  });

  it('allows automatic microphone requests with speech disabled', () => {
    for (const signal of [
      { event: 'ask', reason: 'approve' },
      { event: 'ask', reason: 'answer' },
      { event: 'listen' },
    ] as const) expect(canAutoListen(signal, { ...enabled, voiceResponse: false })).toBe(true);
  });

  it('rejects old or ambiguous ask signals without a known purpose', () => {
    expect(canAutoListen({ event: 'ask' }, enabled)).toBe(false);
    expect(canAutoListen({ event: 'ask', reason: 'done' }, enabled)).toBe(false);
    expect(canAutoListen({ event: 'attention', reason: 'approve' }, enabled)).toBe(false);
  });
});

describe('pickWindow', () => {
  it('chọn folder là tiền tố dài nhất của cwd', () => {
    const a = w(1, 'D:/Project');
    const b = w(2, 'D:/Project/noidle');
    expect(pickWindow([a, b], 'D:/Project/noidle/src', true)?.pid).toBe(2);
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
  it('preserves the CLI source instead of treating it as Chat or Claude', () => {
    expect(parseSignal('{"event":"listen","session":"cli","cwd":"D:/x","source":"copilot-cli"}')?.source).toBe('copilot-cli');
  });
  it('đọc dòng JSON hợp lệ', () => {
    expect(parseSignal('{"event":"listen","session":"s","cwd":"D:/x"}\n')).toEqual({ event: 'listen', session: 's', cwd: 'D:/x' });
  });
  it('giữ danh sách pid tổ tiên (ancestors), bỏ phần tử không phải số', () => {
    expect(parseSignal('{"event":"listen","session":"","cwd":"D:/x","ancestors":[100,90,"x",80]}')?.ancestors).toEqual([100, 90, 80]);
    expect(parseSignal('{"event":"ask","session":"","cwd":"D:/x","ancestors":"nope"}')?.ancestors).toBeUndefined();
    expect(parseSignal('{"event":"listen","session":"","cwd":"D:/x"}')?.ancestors).toBeUndefined();
  });
  it('attention: giữ lý do done/approve/answer, lý do lạ thì bỏ', () => {
    expect(parseSignal('{"event":"attention","session":"s","cwd":"D:/x","reason":"done"}')).toEqual({ event: 'attention', session: 's', cwd: 'D:/x', reason: 'done' });
    expect(parseSignal('{"event":"attention","session":"s","cwd":"D:/x","reason":"approve"}')?.reason).toBe('approve');
    expect(parseSignal('{"event":"attention","session":"s","cwd":"D:/x","reason":"weird"}')?.reason).toBeUndefined();
  });
  it('chatPending/chatDone: giữ toolUseId, command, text; bỏ trường sai kiểu', () => {
    expect(parseSignal('{"event":"chatPending","session":"s","cwd":"D:/x","toolUseId":"call_1__vscode-2","command":"git push","text":"Workspace x needs approval. Bash: git push.","lang":"en"}'))
      .toEqual({ event: 'chatPending', session: 's', cwd: 'D:/x', toolUseId: 'call_1__vscode-2', command: 'git push', text: 'Workspace x needs approval. Bash: git push.', lang: 'en' });
    expect(parseSignal('{"event":"chatPending","session":"s","cwd":"D:/x","command":"x","text":"t","lang":"fr"}')?.lang).toBeUndefined();
    expect(parseSignal('{"event":"chatDone","session":"s","cwd":"D:/x","toolUseId":"call_1__vscode-2","command":"git push"}'))
      .toEqual({ event: 'chatDone', session: 's', cwd: 'D:/x', toolUseId: 'call_1__vscode-2', command: 'git push' });
    expect(parseSignal('{"event":"chatDone","session":"s","cwd":"D:/x","toolUseId":7,"command":null}')).toEqual({ event: 'chatDone', session: 's', cwd: 'D:/x' });
  });
  it('bỏ JSON hỏng, event lạ, thiếu cwd', () => {
    expect(parseSignal('{')).toBeUndefined();
    expect(parseSignal('{"event":"boom","session":"","cwd":"x"}')).toBeUndefined();
    expect(parseSignal('{"event":"listen","session":""}')).toBeUndefined();
  });
});

describe('registry', () => {
  it('ghi, đọc, xoá entry; bỏ file hỏng', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-reg-'));
    writeRegistry(w(11, 'D:/a'), dir);
    writeRegistry(w(12, 'D:/b'), dir);
    fs.writeFileSync(path.join(dir, '13.json'), '{oops', 'utf8');
    expect(readRegistry(dir).map((e) => e.pid).sort()).toEqual([11, 12]);
    removeRegistry(11, dir);
    expect(readRegistry(dir).map((e) => e.pid)).toEqual([12]);
    expect(readRegistry(path.join(dir, 'missing'))).toEqual([]);
  });
});

const testPipe = () => pipeName(process.pid * 1000 + Math.floor(Math.random() * 1000));

describe('server/client', () => {
  it('gửi một dòng JSON qua pipe và nhận được', async () => {
    const pipe = testPipe();
    const got: unknown[] = [];
    const server = startServer(pipe, (s) => void got.push(s));
    await new Promise((r) => server.once('listening', r));
    expect(await sendSignal(pipe, { event: 'listen', session: 's1', cwd: 'D:/x' })).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([{ event: 'listen', session: 's1', cwd: 'D:/x' }]);
    server.close();
  });
  it('signalWindow với prune=false giữ entry chết (attention không được xoá cửa sổ chỉ vì chưa trả lời)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-sig-'));
    writeRegistry({ pid: 7, pipe: testPipe(), folders: ['D:/dead'] }, dir);
    expect(await signalWindow({ event: 'attention', session: '', cwd: 'D:/dead', reason: 'done' }, dir, undefined, false)).toBe(false);
    expect(readRegistry(dir).map((e) => e.pid)).toEqual([7]);
    expect(await signalWindow({ event: 'listen', session: '', cwd: 'D:/dead' }, dir)).toBe(false);
    expect(readRegistry(dir)).toEqual([]);
  });
  it('pipe chết thì trả false, không ném', async () => {
    expect(await sendSignal(testPipe(), { event: 'listen', session: '', cwd: 'x' }, 500)).toBe(false);
  });
  it('signalWindow chọn cửa sổ theo cwd và dọn entry chết', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-sig-'));
    const pipe = testPipe();
    const got: unknown[] = [];
    const server = startServer(pipe, (s) => void got.push(s));
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

describe('ask', () => {
  it('parseSignal nhận ask kèm timeoutSec', () => {
    expect(parseSignal('{"event":"ask","session":"s","cwd":"D:/x","timeoutSec":7}')).toEqual({ event: 'ask', session: 's', cwd: 'D:/x', timeoutSec: 7 });
  });
  it('server trả lời heard, client nhận được; pipe chết thì undefined', async () => {
    const pipe = testPipe();
    const server = startServer(pipe, async (s) => (s.event === 'ask' ? `nghe ${s.timeoutSec}` : undefined));
    await new Promise((r) => server.once('listening', r));
    expect(await askSignal(pipe, { event: 'ask', session: '', cwd: 'D:/x', timeoutSec: 7 }, 2000)).toBe('nghe 7');
    expect(await askSignal(testPipe(), { event: 'ask', session: '', cwd: 'D:/x' }, 500)).toBeUndefined();
    server.close();
  });
  it('askWindow chọn cửa sổ theo cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-ask-'));
    const pipe = testPipe();
    const server = startServer(pipe, async () => 'đồng ý');
    await new Promise((r) => server.once('listening', r));
    writeRegistry({ pid: 5, pipe, folders: ['D:/live'] }, dir);
    expect(await askWindow({ event: 'ask', session: '', cwd: 'D:/live/x', timeoutSec: 1 }, dir)).toBe('đồng ý');
    expect(await askWindow({ event: 'ask', session: '', cwd: 'D:/none', timeoutSec: 1 }, dir)).toBeUndefined();
    server.close();
  });
});

describe('pruneRegistry', () => {
  it('xoá file đăng ký của pid đã chết, trả về các cửa sổ còn sống', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-prune-'));
    writeRegistry(w(21, 'D:/a'), dir);
    writeRegistry(w(22, 'D:/b'), dir);
    writeRegistry(w(23, 'D:/c'), dir);
    const live = pruneRegistry(dir, (pid) => pid !== 22);
    expect(live.map((e) => e.pid).sort()).toEqual([21, 23]);
    expect(readRegistry(dir).map((e) => e.pid).sort()).toEqual([21, 23]);
  });
});

describe('routeSignal: hỏi cửa sổ nào chứa agent (probe) rồi mới gửi', () => {
  /** Server giả của một cửa sổ: probe trả 'owned' khi pid của nó nằm trong chuỗi, 'no' nếu không; tín hiệu thật được ghi lại. */
  const win = async (pid: number, got: Signal[], heard = 'yes') => {
    const pipe = testPipe();
    const server = startServer(pipe, (s) => {
      if (s.event === 'probe') return s.ancestors?.includes(pid) ? 'owned' : 'no';
      got.push(s);
      return s.event === 'ask' ? heard : undefined;
    });
    await new Promise((r) => server.once('listening', r));
    return { pipe, server };
  };
  const sig = (event: Signal['event'], cwd: string, ancestors?: number[]): Signal =>
    ({ event, session: 's', cwd, ...(event === 'attention' ? { reason: 'done' as const } : {}), ...(ancestors ? { ancestors } : {}) });

  it('cửa sổ có pid trong chuỗi nhận tín hiệu, dù cwd khớp cửa sổ khác dài hơn (workspace cha và project con)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotParent: Signal[] = []; const gotChild: Signal[] = [];
    const parent = await win(1001, gotParent); const child = await win(1002, gotChild);
    writeRegistry({ pid: 1001, pipe: parent.pipe, folders: ['D:/parent'] }, dir);
    writeRegistry({ pid: 1002, pipe: child.pipe, folders: ['D:/parent/child'] }, dir);
    const r = await routeSignal(sig('listen', 'D:/parent/child', [500, 400, 1001, 10]), { cwdFallback: false }, dir, undefined, () => true);
    expect(r).toEqual({ ok: true, pid: 1001, via: 'owner' });
    await new Promise((r) => setTimeout(r, 50));
    expect(gotParent.map((s) => [s.event, s.ancestors])).toEqual([['listen', [500, 400, 1001, 10]]]);
    expect(gotChild).toEqual([]);
    parent.server.close(); child.server.close();
  });

  it('ask: probe trước, rồi chỉ cửa sổ chủ nghe và trả chữ', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotA: Signal[] = []; const gotB: Signal[] = [];
    const a = await win(1001, gotA, 'allow'); const b = await win(1002, gotB, 'deny');
    writeRegistry({ pid: 1001, pipe: a.pipe, folders: ['D:/a'] }, dir);
    writeRegistry({ pid: 1002, pipe: b.pipe, folders: ['D:/a'] }, dir);
    const r = await routeSignal({ ...sig('ask', 'D:/a', [7, 1002]), timeoutSec: 1 }, { ask: true, cwdFallback: false }, dir, undefined, () => true);
    expect(r).toEqual({ ok: true, pid: 1002, via: 'owner', heard: 'deny' });
    expect(gotA).toEqual([]);
    expect(gotB.map((s) => s.event)).toEqual(['ask']);
    a.server.close(); b.server.close();
  });

  it('chuỗi hợp lệ mà không cửa sổ nào chứa agent: cwdFallback false thì không gửi cho ai (agent ở terminal rời)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotA: Signal[] = [];
    const a = await win(1001, gotA);
    writeRegistry({ pid: 1001, pipe: a.pipe, folders: ['D:/a'] }, dir);
    expect(await routeSignal(sig('attention', 'D:/a', [500, 9999]), { cwdFallback: false }, dir, undefined, () => true)).toEqual({ ok: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(gotA).toEqual([]);
    a.server.close();
  });

  it('cwdFallback true: không ai nhận thì gửi cho cửa sổ theo cwd, bỏ chuỗi pid; không có chuỗi thì gửi thẳng theo cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const gotA: Signal[] = [];
    const a = await win(1001, gotA);
    writeRegistry({ pid: 1001, pipe: a.pipe, folders: ['D:/a'] }, dir);
    writeRegistry({ pid: 1002, pipe: testPipe(), folders: ['D:/a'] }, dir);
    expect(await routeSignal(sig('submitted', 'D:/a/sub', [500, 9999]), { cwdFallback: true }, dir, undefined, (pid) => pid === 1001)).toEqual({ ok: true, pid: 1001, via: 'cwd' });
    expect(await routeSignal(sig('submitted', 'D:/a'), { cwdFallback: true }, dir, undefined, (pid) => pid === 1001)).toEqual({ ok: true, pid: 1001, via: 'cwd' });
    await new Promise((r) => setTimeout(r, 50));
    expect(gotA.map((s) => s.ancestors)).toEqual([undefined, undefined]);
    expect(readRegistry(dir).map((e) => e.pid)).toEqual([1001]);
    expect(await routeSignal(sig('submitted', 'D:/none'), { cwdFallback: true }, dir, undefined, () => true)).toEqual({ ok: false });
    a.server.close();
  });
});

describe('routeSignal: probe là sự kiện riêng để extension cũ không xử lý nhầm', () => {
  it('cửa sổ chạy extension cũ (không biết probe, đóng kết nối không trả lời) được coi là không chứa agent', async () => {
    // Extension cũ: parseSignal không nhận event lạ → đóng socket không trả lời. Nếu probe là tín hiệu thật kèm cờ,
    // extension cũ sẽ mở mic / đọc "cần approve" / tắt mic ở mọi cửa sổ trong lúc chưa reload.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-route-'));
    const oldGot: string[] = [];
    const oldPipe = testPipe();
    const old = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (d) => { oldGot.push(String(d)); socket.end(); });
    });
    old.listen(oldPipe);
    await new Promise((r) => old.once('listening', r));
    writeRegistry({ pid: 1001, pipe: oldPipe, folders: ['D:/a'] }, dir);
    const r = await routeSignal({ event: 'ask', session: 's', cwd: 'D:/a', ancestors: [7, 1001], timeoutSec: 1 }, { ask: true, cwdFallback: false }, dir, undefined, () => true);
    expect(r).toEqual({ ok: false });
    // Cửa sổ cũ chỉ thấy một dòng probe (event riêng), không thấy tín hiệu ask.
    expect(oldGot).toHaveLength(1);
    expect(JSON.parse(oldGot[0]).event).toBe('probe');
    old.close();
  });
  it('parseSignal nhận probe là một event, và không còn cờ probe trên tín hiệu khác', () => {
    expect(parseSignal(JSON.stringify({ event: 'probe', cwd: 'D:/a', ancestors: [1, 2] }))).toEqual({ event: 'probe', session: '', cwd: 'D:/a', ancestors: [1, 2] });
    expect(parseSignal(JSON.stringify({ event: 'listen', cwd: 'D:/a', probe: true }))).toEqual({ event: 'listen', session: '', cwd: 'D:/a' });
  });
});

describe('registry và parseSignal mang thêm pid editor, probe, startedAt', () => {
  it('editorPid được ghi và đọc lại; thiếu thì undefined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-reg-'));
    writeRegistry({ pid: 1, pipe: 'p', folders: ['D:/a'], editorPid: 11384 }, dir);
    writeRegistry({ pid: 2, pipe: 'q', folders: ['D:/b'] }, dir);
    const byPid = Object.fromEntries(readRegistry(dir).map((e) => [e.pid, e.editorPid]));
    expect(byPid).toEqual({ 1: 11384, 2: undefined });
  });
  it('parseSignal giữ startedAt và source của attention', () => {
    const s = parseSignal(JSON.stringify({ event: 'attention', cwd: 'D:/a', reason: 'done', startedAt: 1700000000000, source: 'copilot' }));
    expect(s).toMatchObject({ startedAt: 1700000000000, source: 'copilot' });
    expect(parseSignal(JSON.stringify({ event: 'listen', cwd: 'D:/a', startedAt: 'x' }))).toEqual({ event: 'listen', session: '', cwd: 'D:/a' });
  });
});
