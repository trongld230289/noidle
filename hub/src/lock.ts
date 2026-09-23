/** Khoá server: một file trong thư mục gốc ghi pid, cổng và lần cuối có người xem, để hook biết server sống và có ai xem. */
import * as fs from 'fs';
import * as path from 'path';

export interface HubLock {
  pid: number;
  port: number;
  at: number;
  /** Lần cuối có request hay SSE còn mở. */
  lastClientAt: number;
}

/** Có người xem nếu client hoạt động trong khoảng này. */
export const VIEWER_WINDOW_MS = 60_000;

export function lockPath(root: string): string {
  return path.join(root, 'hub.lock');
}

export function readLock(root: string): HubLock | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(lockPath(root), 'utf8')) as Partial<HubLock>;
    if (typeof o.pid !== 'number' || typeof o.port !== 'number') return undefined;
    return { pid: o.pid, port: o.port, at: Number(o.at) || 0, lastClientAt: Number(o.lastClientAt) || 0 };
  } catch {
    return undefined;
  }
}

export function writeLock(root: string, lock: HubLock): void {
  fs.mkdirSync(root, { recursive: true });
  const file = lockPath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock), 'utf8');
  fs.renameSync(tmp, file);
}

export function removeLock(root: string, pid: number): void {
  const cur = readLock(root);
  if (cur && cur.pid !== pid) return;
  try {
    fs.unlinkSync(lockPath(root));
  } catch {
    /* không có */
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Server đang chạy và có người xem trong VIEWER_WINDOW_MS. */
export function hasViewer(lock: HubLock | undefined, now = Date.now(), alive: (pid: number) => boolean = pidAlive): boolean {
  return !!lock && alive(lock.pid) && now - lock.lastClientAt <= VIEWER_WINDOW_MS;
}
