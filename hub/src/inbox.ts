/**
 * Hộp thư: mỗi phiên Claude Code một file JSON trong thư mục inbox, hook ghi đè mỗi sự kiện, server đọc để hiện.
 * Kèm ba loại file phụ theo phiên, đọc một lần là xoá: decision (approve / trả lời từ web), queue (lệnh kế tiếp),
 * flag (cờ nội bộ, ví dụ "lượt Stop này do mình chặn").
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type State = 'working' | 'waiting_approve' | 'waiting_answer' | 'done';

export interface Pending {
  kind: 'approve' | 'question';
  toolName?: string;
  summary?: string;
  question?: string;
  options?: string[];
  multiSelect?: boolean;
  dangerous?: boolean;
  since: number;
}

export interface InboxEntry {
  session: string;
  cwd: string;
  workspace: string;
  state: State;
  updatedAt: number;
  /** Phần 🔊 của câu trả lời cuối. */
  lastSpoken?: string;
  /** Toàn bộ câu trả lời cuối (markdown thô, cắt ở MAX_FULL), để xem như trong terminal. */
  lastFull?: string;
  /** 200 ký tự đầu prompt cuối của người dùng. */
  lastPrompt?: string;
  pending?: Pending;
  /** Lệnh đang xếp hàng, chạy khi phiên xong lượt hiện tại. */
  queued?: string;
}

export interface Decision {
  decision?: 'allow' | 'deny';
  answer?: string | number[];
}

/** Phiên không có sự kiện quá lâu thì không hiện nữa. */
export const MAX_AGE_MS = 12 * 3600_000;

export function hubRoot(): string {
  return path.join(os.tmpdir(), 'vi-voice-hub');
}

export function inboxDir(root = hubRoot()): string {
  return path.join(root, 'inbox');
}

const safe = (session: string) => session.replace(/[^\w.-]/g, '_');
const entryPath = (dir: string, session: string) => path.join(dir, `${safe(session)}.json`);

/** Ghi tạm rồi đổi tên để server không đọc phải file viết dở. */
function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function isEntry(o: unknown): o is InboxEntry {
  const e = o as Partial<InboxEntry> | undefined;
  return !!e && typeof e.session === 'string' && typeof e.state === 'string' && typeof e.updatedAt === 'number';
}

const STATE_ORDER: Record<State, number> = { waiting_approve: 0, waiting_answer: 0, working: 1, done: 2 };

/** Đọc mọi phiên còn mới, bỏ file hỏng; sắp: đang chờ (chờ lâu nhất trước), đang làm, đã xong (mới nhất trước). */
export function readInbox(dir: string, now = Date.now()): InboxEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: InboxEntry[] = [];
  for (const f of files) {
    const e = readJson<unknown>(path.join(dir, f));
    if (!isEntry(e)) continue;
    if (now - e.updatedAt > MAX_AGE_MS) continue;
    out.push(e);
  }
  return out.sort((a, b) => {
    const ga = STATE_ORDER[a.state] ?? 3;
    const gb = STATE_ORDER[b.state] ?? 3;
    if (ga !== gb) return ga - gb;
    if (ga === 0) return (a.pending?.since ?? a.updatedAt) - (b.pending?.since ?? b.updatedAt);
    return b.updatedAt - a.updatedAt;
  });
}

export type InboxPatch = Partial<Omit<InboxEntry, 'session' | 'updatedAt'>> & { clearPending?: boolean; clearQueued?: boolean };

/** Gộp patch vào entry hiện có (hoặc tạo mới) rồi ghi. Trả về entry sau khi gộp. */
export function updateInbox(dir: string, session: string, patch: InboxPatch, now = Date.now()): InboxEntry {
  const file = entryPath(dir, session);
  const current = readJson<unknown>(file);
  const base: InboxEntry = isEntry(current) ? current : { session, cwd: '', workspace: '', state: 'working', updatedAt: now };
  const { clearPending, clearQueued, ...fields } = patch;
  const next: InboxEntry = { ...base, ...stripUndefined(fields), session, updatedAt: now };
  if (clearPending) delete next.pending;
  if (clearQueued) delete next.queued;
  writeAtomic(file, JSON.stringify(next));
  return next;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sidePath(dir: string, session: string, kind: string): string {
  return path.join(dir, `${safe(session)}.${kind}`);
}

function takeSide<T>(file: string): T | undefined {
  const v = readJson<T>(file);
  try {
    fs.unlinkSync(file);
  } catch {
    /* không có */
  }
  return v;
}

export function writeDecision(dir: string, session: string, d: Decision): void {
  writeAtomic(sidePath(dir, session, 'decision'), JSON.stringify(d));
}

export function takeDecision(dir: string, session: string): Decision | undefined {
  const d = takeSide<Decision>(sidePath(dir, session, 'decision'));
  return d && typeof d === 'object' ? d : undefined;
}

export function writeQueue(dir: string, session: string, text: string): void {
  writeAtomic(sidePath(dir, session, 'queue'), JSON.stringify({ text }));
}

export function takeQueue(dir: string, session: string): string | undefined {
  const q = takeSide<{ text?: unknown }>(sidePath(dir, session, 'queue'));
  return q && typeof q.text === 'string' && q.text.trim() ? q.text : undefined;
}

export function setFlag(dir: string, session: string, name: string): void {
  writeAtomic(sidePath(dir, session, `flag.${name}`), '1');
}

export function takeFlag(dir: string, session: string, name: string): boolean {
  const file = sidePath(dir, session, `flag.${name}`);
  if (!fs.existsSync(file)) return false;
  try {
    fs.unlinkSync(file);
  } catch {
    /* đã mất */
  }
  return true;
}

/** Dòng sự kiện dùng chung cho trang: mỗi sự kiện một dòng JSONL, chỉ giữ MAX_EVENTS dòng cuối. */
export interface HubEvent {
  at: number;
  session: string;
  workspace: string;
  kind: 'prompt' | 'done' | 'approve' | 'question' | 'decided' | 'queued' | 'run';
  text?: string;
}
export const MAX_EVENTS = 200;
const EVENTS_FILE = 'events.jsonl';

export function appendEvent(dir: string, ev: HubEvent): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, EVENTS_FILE);
  fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
  // Cắt bớt thỉnh thoảng để file không phình mãi.
  if (Math.random() < 0.05) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_EVENTS) fs.writeFileSync(file, lines.slice(-MAX_EVENTS).join('\n') + '\n', 'utf8');
    } catch {
      /* bỏ qua */
    }
  }
}

export function readEvents(dir: string, limit = 40): HubEvent[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(dir, EVENTS_FILE), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out: HubEvent[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as HubEvent;
      if (typeof e.at === 'number' && typeof e.kind === 'string') out.push(e);
    } catch {
      /* dòng hỏng */
    }
  }
  return out.slice(-limit).reverse();
}
