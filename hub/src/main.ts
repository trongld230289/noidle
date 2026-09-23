/**
 * CLI của hub, đóng gói thành dist/hub.js:
 *   install [--lan] [--port N] [--lang vi|en]   bật cấu hình, thêm hook vào ~/.claude/settings.json, in URL
 *   uninstall                                    gỡ hook, tắt cấu hình
 *   hook <Event>                                 Claude Code gọi: đọc stdin, ghi hộp thư, chờ quyết định từ web khi có người xem
 *   serve                                        tiến trình nền giữ cổng (hook tự tách khi cần)
 *   open                                         in URL và mở trình duyệt
 *   status                                       in cấu hình, khoá, các phiên
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { loadConfig, ensureConfig, saveConfig, configPath, HubConfig } from './config';
import { updateClaudeSettings, claudeSettingsPath } from './settings';
import { handleHook, HookInput } from './hook';
import { hubRoot, inboxDir, readInbox, takeDecision, Decision, Pending } from './inbox';
import { readLock, writeLock, removeLock, pidAlive, hasViewer } from './lock';
import { startHub } from './hub';

export const VERSION = '0.1.0';
const IDLE_EXIT_MS = 4 * 3600_000;
const LOCK_REFRESH_MS = 60_000;
const DECISION_POLL_MS = 300;
const PORT_TRIES = 5;

const root = hubRoot();
const LOG_FILE = path.join(root, 'hub.log');

function log(msg: string): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {
    /* bỏ qua */
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 3000);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/** URL vào trang: loopback, và mỗi IPv4 của máy khi bật lan. */
export function urls(cfg: HubConfig, port = cfg.port): string[] {
  const out = [`http://127.0.0.1:${port}/t/${cfg.token}/`];
  if (cfg.lan) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${port}/t/${cfg.token}/`);
    }
  }
  return out;
}

/** Tách server nền nếu chưa có cái nào sống. Không chờ nó lên. */
function ensureServe(): void {
  if (process.env.VI_VOICE_HUB_NO_SERVE) return;
  const lock = readLock(root);
  if (lock && pidAlive(lock.pid)) return;
  const child = spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  log(`tách server pid ${child.pid}`);
}

/** Chờ quyết định từ web: chỉ khi server sống và có người xem trong 60s; poll file mỗi 300ms tới waitSec. */
async function waitForDecision(cfg: HubConfig, session: string, pending: Pending): Promise<Decision | undefined> {
  const dir = inboxDir(root);
  const early = takeDecision(dir, session);
  if (early) return early;
  if (!hasViewer(readLock(root))) return undefined;
  log(`${pending.kind}: có người xem, chờ tối đa ${cfg.waitSec}s (${session.slice(0, 8)})`);
  const deadline = Date.now() + cfg.waitSec * 1000;
  let lastAlive = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DECISION_POLL_MS));
    const d = takeDecision(dir, session);
    if (d) {
      log(`${pending.kind}: nhận từ web ${JSON.stringify(d)}`);
      return d;
    }
    if (Date.now() - lastAlive > 3000) {
      lastAlive = Date.now();
      const lock = readLock(root);
      if (!lock || !pidAlive(lock.pid)) {
        log(`${pending.kind}: server chết, thôi chờ`);
        return undefined;
      }
    }
  }
  log(`${pending.kind}: hết giờ, không có quyết định`);
  return undefined;
}

async function cmdHook(event: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.enabled) return;
  let input: HookInput = {};
  try {
    input = JSON.parse((await readStdin()) || '{}') as HookInput;
  } catch {
    log(`hook ${event}: stdin không phải JSON`);
  }
  ensureServe();
  const out = await handleHook(event, input, {
    dir: inboxDir(root),
    cfg,
    log: (m) => log(`hook ${event}: ${m}`),
    wait: (session, pending) => waitForDecision(cfg, session, pending),
  });
  if (out) process.stdout.write(JSON.stringify(out));
}

async function cmdServe(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    log('serve: cấu hình đang tắt, thoát');
    return;
  }
  const existing = readLock(root);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    log(`serve: pid ${existing.pid} đang chạy, thoát`);
    return;
  }
  const host = cfg.lan ? '0.0.0.0' : '127.0.0.1';
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let lastErr: Error | undefined;
  for (let i = 0; i < PORT_TRIES && !hub; i++) {
    try {
      hub = await startHub({ dir: inboxDir(root), token: cfg.token, port: cfg.port + i, host, lang: cfg.lang, version: VERSION, log, onClient: (at) => refreshLock(at) });
    } catch (err) {
      lastErr = err as Error;
      log(`serve: cổng ${cfg.port + i} lỗi: ${lastErr.message}`);
    }
  }
  if (!hub) {
    log(`serve: không mở được cổng nào: ${lastErr?.message}`);
    return;
  }
  const started = hub;
  let lastLockWrite = 0;
  const refreshLock = (clientAt?: number) => {
    const now = Date.now();
    if (clientAt !== undefined && now - lastLockWrite < 2000) return;
    lastLockWrite = now;
    writeLock(root, { pid: process.pid, port: started.port, at: now, lastClientAt: started.lastClientAt() });
  };
  refreshLock();
  const ticker = setInterval(refreshLock, LOCK_REFRESH_MS);
  const idle = setInterval(() => {
    const now = Date.now();
    let inboxAt = 0;
    try {
      inboxAt = fs.statSync(inboxDir(root)).mtimeMs;
    } catch {
      /* chưa có */
    }
    if (now - started.lastClientAt() > IDLE_EXIT_MS && now - inboxAt > IDLE_EXIT_MS) {
      log('serve: 4 giờ không ai dùng, thoát');
      void shutdown();
    }
  }, 5 * 60_000);
  const shutdown = async () => {
    clearInterval(ticker);
    clearInterval(idle);
    await started.close();
    removeLock(root, process.pid);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  log(`serve: sẵn sàng ${urls(cfg, started.port).join(' ')}`);
  // Giữ tiến trình sống cho tới khi thoát.
  await new Promise(() => undefined);
}

function cmdInstall(): void {
  const patch: Partial<HubConfig> = {};
  if (flag('lan')) patch.lan = true;
  if (flag('local')) patch.lan = false;
  const port = Number(opt('port'));
  if (port > 0) patch.port = port;
  const lang = opt('lang');
  if (lang === 'vi' || lang === 'en') patch.lang = lang;
  const cfg = ensureConfig(patch);
  const settings = updateClaudeSettings(__filename, true);
  console.log(`Đã thêm hook vào ${settings}`);
  console.log(`Cấu hình: ${configPath()}`);
  console.log(cfg.lan ? 'Nghe trên mọi địa chỉ (LAN). Ai có URL là ra lệnh được, chỉ dùng trong mạng tin cậy.' : 'Chỉ nghe trên máy này. Thêm --lan để mở cho điện thoại trong mạng.');
  console.log('Mở trang:');
  for (const u of urls(cfg)) console.log(`  ${u}`);
  console.log('Phiên Claude Code đang mở cần khởi động lại để nhận hook.');
}

function cmdUninstall(): void {
  const settings = updateClaudeSettings(__filename, false);
  const cfg = loadConfig();
  saveConfig({ ...cfg, enabled: false });
  const lock = readLock(root);
  if (lock && pidAlive(lock.pid)) {
    try {
      process.kill(lock.pid);
    } catch {
      /* đã thoát */
    }
  }
  console.log(`Đã gỡ hook khỏi ${settings} và tắt hub.`);
}

function cmdOpen(): void {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    console.log('Hub chưa bật. Chạy: node hub.js install [--lan]');
    return;
  }
  ensureServe();
  const lock = readLock(root);
  const list = urls(cfg, lock?.port ?? cfg.port);
  for (const u of list) console.log(u);
  const target = list[0];
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try {
    spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* không mở được trình duyệt, đã in URL */
  }
}

function cmdStatus(): void {
  const cfg = loadConfig();
  const lock = readLock(root);
  console.log(`Cấu hình ${configPath()}: ${JSON.stringify({ ...cfg, token: cfg.token.slice(0, 6) + '…' })}`);
  console.log(`Settings Claude Code: ${claudeSettingsPath()}`);
  console.log(lock ? `Server: pid ${lock.pid} ${pidAlive(lock.pid) ? 'sống' : 'chết'}, cổng ${lock.port}, người xem ${hasViewer(lock) ? 'có' : 'không'}` : 'Server: chưa chạy');
  const sessions = readInbox(inboxDir(root));
  console.log(`Phiên (${sessions.length}):`);
  for (const s of sessions) console.log(`  ${s.state.padEnd(16)} ${s.workspace.padEnd(20)} ${(s.lastSpoken ?? s.lastPrompt ?? '').slice(0, 60)}`);
  for (const u of urls(cfg, lock?.port ?? cfg.port)) console.log(u);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'hook':
      return cmdHook(process.argv[3] ?? '');
    case 'serve':
      return cmdServe();
    case 'install':
      return cmdInstall();
    case 'uninstall':
      return cmdUninstall();
    case 'open':
      return cmdOpen();
    case 'status':
      return cmdStatus();
    default:
      console.log('usage: hub.js install [--lan] [--port N] [--lang vi|en] | uninstall | open | status | serve | hook <Event>');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  log(`lỗi ${process.argv.slice(2).join(' ')}: ${(err as Error).stack ?? err}`);
  console.error((err as Error).message);
  process.exitCode = 1;
});
