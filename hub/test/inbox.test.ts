import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readInbox, updateInbox, writeDecision, takeDecision, writeQueue, takeQueue, setFlag, takeFlag, MAX_AGE_MS } from '../src/inbox';

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-inbox-'));

describe('updateInbox', () => {
  it('creates an entry with updatedAt and keeps old fields on later patches', () => {
    const dir = fresh();
    const a = updateInbox(dir, 's1', { cwd: 'D:/p/shop', workspace: 'shop', state: 'working', lastPrompt: 'sửa lỗi' }, 1000);
    expect(a).toMatchObject({ session: 's1', cwd: 'D:/p/shop', workspace: 'shop', state: 'working', lastPrompt: 'sửa lỗi', updatedAt: 1000 });
    const b = updateInbox(dir, 's1', { state: 'done', lastSpoken: 'Xong rồi.' }, 2000);
    expect(b).toMatchObject({ cwd: 'D:/p/shop', workspace: 'shop', state: 'done', lastSpoken: 'Xong rồi.', lastPrompt: 'sửa lỗi', updatedAt: 2000 });
    expect(readInbox(dir, 2000)).toHaveLength(1);
  });
  it('clearPending and clearQueued remove those fields', () => {
    const dir = fresh();
    updateInbox(dir, 's1', { cwd: 'D:/p', workspace: 'p', state: 'waiting_approve', pending: { kind: 'approve', toolName: 'Bash', since: 5 }, queued: 'chạy test' }, 5);
    const e = updateInbox(dir, 's1', { state: 'working', clearPending: true, clearQueued: true }, 6);
    expect(e.pending).toBeUndefined();
    expect(e.queued).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 's1.json'), 'utf8'))).not.toHaveProperty('clearPending');
  });
  it('sanitises the session id in the file name', () => {
    const dir = fresh();
    updateInbox(dir, 'a/b:c', { cwd: 'D:/p', workspace: 'p', state: 'working' }, 1);
    expect(fs.existsSync(path.join(dir, 'a_b_c.json'))).toBe(true);
    expect(readInbox(dir, 1)[0].session).toBe('a/b:c');
  });
});

describe('readInbox', () => {
  it('skips broken files and entries older than 12 hours', () => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    updateInbox(dir, 'old', { cwd: 'D:/o', workspace: 'o', state: 'done' }, 1000);
    updateInbox(dir, 'new', { cwd: 'D:/n', workspace: 'n', state: 'done' }, 1000 + MAX_AGE_MS);
    const list = readInbox(dir, 1000 + MAX_AGE_MS + 1);
    expect(list.map((e) => e.session)).toEqual(['new']);
  });
  it('orders waiting (oldest first), then working, then done (newest first)', () => {
    const dir = fresh();
    updateInbox(dir, 'd1', { cwd: 'D:/1', workspace: '1', state: 'done' }, 10);
    updateInbox(dir, 'd2', { cwd: 'D:/2', workspace: '2', state: 'done' }, 20);
    updateInbox(dir, 'w1', { cwd: 'D:/3', workspace: '3', state: 'working' }, 15);
    updateInbox(dir, 'a2', { cwd: 'D:/4', workspace: '4', state: 'waiting_answer', pending: { kind: 'question', since: 8 } }, 9);
    updateInbox(dir, 'a1', { cwd: 'D:/5', workspace: '5', state: 'waiting_approve', pending: { kind: 'approve', since: 3 } }, 4);
    expect(readInbox(dir, 30).map((e) => e.session)).toEqual(['a1', 'a2', 'w1', 'd2', 'd1']);
  });
  it('returns [] when the directory does not exist', () => {
    expect(readInbox(path.join(fresh(), 'nope'))).toEqual([]);
  });
});

describe('decision, queue and flags are taken once', () => {
  it('decision', () => {
    const dir = fresh();
    expect(takeDecision(dir, 's')).toBeUndefined();
    writeDecision(dir, 's', { decision: 'allow' });
    expect(takeDecision(dir, 's')).toEqual({ decision: 'allow' });
    expect(takeDecision(dir, 's')).toBeUndefined();
    writeDecision(dir, 's', { answer: [0, 2] });
    expect(takeDecision(dir, 's')).toEqual({ answer: [0, 2] });
  });
  it('queue', () => {
    const dir = fresh();
    writeQueue(dir, 's', 'chạy test rồi commit');
    expect(takeQueue(dir, 's')).toBe('chạy test rồi commit');
    expect(takeQueue(dir, 's')).toBeUndefined();
  });
  it('flag', () => {
    const dir = fresh();
    expect(takeFlag(dir, 's', 'ours')).toBe(false);
    setFlag(dir, 's', 'ours');
    expect(takeFlag(dir, 's', 'ours')).toBe(true);
    expect(takeFlag(dir, 's', 'ours')).toBe(false);
  });
});

import { appendEvent, readEvents } from '../src/inbox';
describe('events feed', () => {
  it('appends and reads newest first, skipping broken lines', () => {
    const dir = fresh();
    expect(readEvents(dir)).toEqual([]);
    appendEvent(dir, { at: 1, session: 'a', workspace: 'shop', kind: 'prompt', text: 'sửa lỗi' });
    appendEvent(dir, { at: 2, session: 'a', workspace: 'shop', kind: 'done', text: 'Xong.' });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), 'oops\n');
    appendEvent(dir, { at: 3, session: 'b', workspace: 'api', kind: 'approve', text: 'npm test' });
    expect(readEvents(dir).map((e) => e.at)).toEqual([3, 2, 1]);
    expect(readEvents(dir, 2).map((e) => e.at)).toEqual([3, 2]);
  });
});
