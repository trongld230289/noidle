import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { startHub, HubServer } from '../src/hub';
import { updateInbox, takeQueue, takeDecision, readInbox } from '../src/inbox';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-server-'));
const token = 'f'.repeat(32);
let hub: HubServer;
let base: string;
const clients: number[] = [];

beforeAll(async () => {
  hub = await startHub({ dir, token, port: 0, host: '127.0.0.1', lang: 'vi', version: '0.1.0-test', onClient: (at) => clients.push(at) });
  base = `http://127.0.0.1:${hub.port}/t/${token}`;
});
afterAll(async () => {
  await hub.close();
});

const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('routing and auth', () => {
  it('serves the page and ping under the token, 404 otherwise', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Vi Voice Hub</title>');
    expect(((await (await get('/api/ping')).json()) as { ok: boolean }).ok).toBe(true);
    expect((await fetch(`http://127.0.0.1:${hub.port}/t/${'0'.repeat(32)}/api/state`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${hub.port}/api/state`)).status).toBe(404);
    expect((await get('/nope')).status).toBe(404);
    expect(hub.lastClientAt()).toBeGreaterThan(0);
    expect(clients.length).toBeGreaterThan(0);
  });
});

describe('state', () => {
  it('lists sessions from the inbox in order', async () => {
    updateInbox(dir, 'done1', { cwd: 'D:/a', workspace: 'a', state: 'done', lastSpoken: 'xong' }, Date.now() - 1000);
    updateInbox(dir, 'wait1', { cwd: 'D:/b', workspace: 'b', state: 'waiting_approve', pending: { kind: 'approve', toolName: 'Bash', summary: 'npm test', since: Date.now() } });
    const s = (await (await get('/api/state')).json()) as { sessions: { session: string }[]; host: string };
    expect(s.sessions.map((x: { session: string }) => x.session)).toEqual(['wait1', 'done1']);
    expect(s.host).toBe(os.hostname());
  });
});

describe('send', () => {
  it('queues a command for a working or done session and refuses for waiting ones', async () => {
    const r = await post('/api/send', { session: 'done1', text: '  chạy test  ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ queued: true });
    expect(readInbox(dir).find((e) => e.session === 'done1')?.queued).toBe('chạy test');
    expect(takeQueue(dir, 'done1')).toBe('chạy test');
    expect((await post('/api/send', { session: 'wait1', text: 'x' })).status).toBe(409);
    expect((await post('/api/send', { session: 'ghost', text: 'x' })).status).toBe(404);
    expect((await post('/api/send', { session: 'done1', text: '' })).status).toBe(400);
    expect((await fetch(base + '/api/send', { method: 'POST', body: '{bad' })).status).toBe(400);
  });
});

describe('decide', () => {
  it('writes allow/deny for approvals, blocks allow on dangerous, and validates answers', async () => {
    expect((await post('/api/decide', { session: 'wait1', decision: 'allow' })).status).toBe(200);
    expect(takeDecision(dir, 'wait1')).toEqual({ decision: 'allow' });
    expect((await post('/api/decide', { session: 'wait1', decision: 'maybe' })).status).toBe(400);
    expect((await post('/api/decide', { session: 'done1', decision: 'allow' })).status).toBe(409);

    updateInbox(dir, 'danger', { cwd: 'D:/c', workspace: 'c', state: 'waiting_approve', pending: { kind: 'approve', toolName: 'Bash', summary: 'rm -rf x', dangerous: true, since: Date.now() } });
    expect((await post('/api/decide', { session: 'danger', decision: 'allow' })).status).toBe(409);
    expect((await post('/api/decide', { session: 'danger', decision: 'deny' })).status).toBe(200);

    updateInbox(dir, 'q', { cwd: 'D:/d', workspace: 'd', state: 'waiting_answer', pending: { kind: 'question', question: 'Which?', options: ['Rust', 'Go'], multiSelect: true, since: Date.now() } });
    expect((await post('/api/decide', { session: 'q', answer: [0, 1] })).status).toBe(200);
    expect(takeDecision(dir, 'q')).toEqual({ answer: [0, 1] });
    expect((await post('/api/decide', { session: 'q', answer: [5] })).status).toBe(400);
    expect((await post('/api/decide', { session: 'q', answer: 'Zig' })).status).toBe(200);
    expect(takeDecision(dir, 'q')).toEqual({ answer: 'Zig' });
    expect((await post('/api/decide', { session: 'q', answer: '' })).status).toBe(400);
  });
});

describe('events', () => {
  it('sends the state on connect and again when the inbox changes', async () => {
    const chunks: string[] = [];
    const req = http.get(base + '/api/events', (res) => {
      expect(res.headers['content-type']).toContain('text/event-stream');
      res.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(chunks.join('')).toContain('event: state');
    const before = chunks.length;
    updateInbox(dir, 'live', { cwd: 'D:/e', workspace: 'e', state: 'working' });
    await new Promise((r) => setTimeout(r, 700));
    expect(chunks.length).toBeGreaterThan(before);
    expect(chunks.join('')).toContain('"session":"live"');
    req.destroy();
  });
});
