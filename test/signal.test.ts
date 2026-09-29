import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
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
