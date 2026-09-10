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
  WindowEntry,
} from '../src/signal';

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
