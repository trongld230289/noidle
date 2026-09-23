/** Cấu hình hub tại ~/.vi-voice/hub.json (đổi thư mục gốc bằng env VI_VOICE_HUB_HOME, dùng cho test). */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface HubConfig {
  /** false: hook không ghi gì, không tách server. install bật, uninstall tắt. */
  enabled: boolean;
  port: number;
  /** true: nghe trên mọi địa chỉ để điện thoại trong LAN vào được; false: chỉ 127.0.0.1. */
  lan: boolean;
  /** Token bắt buộc trong mọi đường dẫn. */
  token: string;
  /** Hook chờ quyết định từ web tối đa bao lâu khi đang có người xem trang. */
  waitSec: number;
  lang: 'vi' | 'en';
}

export const DEFAULT_PORT = 4319;

export function configPath(): string {
  return path.join(process.env.VI_VOICE_HUB_HOME || os.homedir(), '.vi-voice', 'hub.json');
}

function defaults(): HubConfig {
  return { enabled: false, port: DEFAULT_PORT, lan: false, token: crypto.randomBytes(16).toString('hex'), waitSec: 90, lang: 'vi' };
}

function normalize(raw: unknown): HubConfig {
  const d = defaults();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof HubConfig, unknown>>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    port: typeof o.port === 'number' && o.port > 0 && o.port < 65536 ? Math.floor(o.port) : d.port,
    lan: typeof o.lan === 'boolean' ? o.lan : d.lan,
    token: typeof o.token === 'string' && /^[0-9a-f]{16,}$/i.test(o.token) ? o.token : d.token,
    waitSec: typeof o.waitSec === 'number' && o.waitSec >= 0 ? o.waitSec : d.waitSec,
    lang: o.lang === 'en' ? 'en' : 'vi',
  };
}

/** Đọc cấu hình; thiếu hay hỏng thì trả mặc định (enabled false) mà không ghi. */
export function loadConfig(): HubConfig {
  try {
    return normalize(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return normalize(undefined);
  }
}

export function saveConfig(c: HubConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(normalize(c), null, 2) + '\n', 'utf8');
}

/** Tạo file nếu chưa có, bật enabled, giữ token cũ nếu đã có. */
export function ensureConfig(patch: Partial<HubConfig> = {}): HubConfig {
  const c: HubConfig = { ...loadConfig(), ...patch, enabled: true };
  saveConfig(c);
  return c;
}
