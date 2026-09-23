/**
 * Server HTTP thuần của Node: phục vụ trang, trạng thái, SSE, và nhận lệnh từ web bằng cách ghi file cho hook.
 * Không chạy lệnh shell nào. Mọi đường dẫn nằm dưới /t/<token>/; sai token trả 404 rỗng.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { readInbox, updateInbox, writeQueue, writeDecision, appendEvent, readEvents, InboxEntry } from './inbox';
import { page } from './page';

export interface HubOptions {
  dir: string;
  token: string;
  port: number;
  host: string;
  lang: 'vi' | 'en';
  version: string;
  /** Gọi mỗi khi có client (request hay SSE còn sống), để ghi lastClientAt vào khoá. */
  onClient?: (at: number) => void;
  log?: (m: string) => void;
}

export interface HubServer {
  port: number;
  close(): Promise<void>;
  lastClientAt(): number;
}

const MAX_BODY = 64 * 1024;
const MAX_TEXT = 4000;
const SSE_HEARTBEAT_MS = 25_000;
const WATCH_DEBOUNCE_MS = 200;

export function startHub(o: HubOptions): Promise<HubServer> {
  const log = o.log ?? (() => undefined);
  const prefix = `/t/${o.token}`;
  let lastClientAt = 0;
  const clients = new Set<http.ServerResponse>();
  const html = page(o.lang);

  const touch = () => {
    lastClientAt = Date.now();
    o.onClient?.(lastClientAt);
  };

  const state = () => ({ host: os.hostname(), version: o.version, lang: o.lang, now: Date.now(), sessions: readInbox(o.dir), events: readEvents(o.dir, 40) });

  const broadcast = () => {
    if (!clients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(state())}\n\n`;
    for (const res of clients) res.write(data);
  };

  // Theo dõi thư mục hộp thư; gộp các thay đổi dồn dập trong 200ms.
  fs.mkdirSync(o.dir, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(o.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(broadcast, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', (err) => log(`watch lỗi: ${err.message}`));
  } catch (err) {
    log(`không theo dõi được thư mục: ${(err as Error).message}`);
  }
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
    if (clients.size) touch();
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const notFound = (res: http.ServerResponse) => {
    res.writeHead(404);
    res.end();
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.length > MAX_BODY) {
          req.destroy();
          resolve(undefined);
        }
      });
      req.on('end', () => {
        try {
          const o = JSON.parse(data || '{}');
          resolve(o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined);
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', () => resolve(undefined));
    });

  const findSession = (session: unknown): InboxEntry | undefined =>
    typeof session === 'string' ? readInbox(o.dir).find((e) => e.session === session) : undefined;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith(prefix)) return notFound(res);
    const rest = (url.slice(prefix.length).split('?')[0] || '/').replace(/\/+$/, '') || '/';
    touch();

    if (req.method === 'GET' && rest === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && rest === '/api/ping') return json(res, 200, { ok: true, version: o.version, host: os.hostname() });
    if (req.method === 'GET' && rest === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && rest === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && rest === '/api/send') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: 'bad_json' });
      const entry = findSession(body.session);
      if (!entry) return json(res, 404, { error: 'no_session' });
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT) return json(res, 400, { error: 'bad_text' });
      if (entry.state === 'waiting_approve' || entry.state === 'waiting_answer') return json(res, 409, { error: 'waiting' });
      writeQueue(o.dir, entry.session, text);
      updateInbox(o.dir, entry.session, { queued: text });
      appendEvent(o.dir, { at: Date.now(), session: entry.session, workspace: entry.workspace, kind: 'queued', text: text.slice(0, 160) });
      log(`send ${entry.workspace}: ${JSON.stringify(text.slice(0, 80))}`);
      return json(res, 200, { queued: true });
    }
    if (req.method === 'POST' && rest === '/api/decide') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: 'bad_json' });
      const entry = findSession(body.session);
      if (!entry?.pending) return json(res, 409, { error: 'not_waiting' });
      if (entry.pending.kind === 'approve') {
        if (body.decision !== 'allow' && body.decision !== 'deny') return json(res, 400, { error: 'bad_decision' });
        if (body.decision === 'allow' && entry.pending.dangerous) return json(res, 409, { error: 'dangerous' });
        writeDecision(o.dir, entry.session, { decision: body.decision });
        log(`decide ${entry.workspace}: ${body.decision}`);
        return json(res, 200, { ok: true });
      }
      const answer = body.answer;
      const n = entry.pending.options?.length ?? 0;
      const valid =
        (typeof answer === 'string' && answer.trim().length > 0 && answer.length <= MAX_TEXT) ||
        (Array.isArray(answer) && answer.length > 0 && answer.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n));
      if (!valid) return json(res, 400, { error: 'bad_answer' });
      writeDecision(o.dir, entry.session, { answer: answer as string | number[] });
      log(`answer ${entry.workspace}: ${JSON.stringify(answer)}`);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : o.port;
      log(`hub nghe ${o.host}:${port}`);
      resolve({
        port,
        lastClientAt: () => lastClientAt,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            clearTimeout(timer);
            watcher?.close();
            for (const c of clients) c.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
