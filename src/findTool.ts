/**
 * Tìm đường dẫn tuyệt đối của ffmpeg/ffplay/node để hook không phụ thuộc PATH của shell chạy Claude.
 *
 * Hook ghi trong ~/.claude/settings.json chạy dưới shell của người dùng. Winget cài ffmpeg xong chỉ cập nhật PATH
 * cho cửa sổ mở SAU đó: PowerShell mở từ trước vẫn giữ PATH cũ, `ffplay` không thấy, trong khi cmd mở mới thì
 * thấy. Extension tìm theo PATH của mình, PATH trong registry (luôn mới dù process giữ PATH cũ) và các thư mục
 * quen thuộc (winget Links, chocolatey, scoop, Homebrew), rồi ghi đường dẫn tuyệt đối vào hook.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface FindDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  /** Các thư mục trong PATH của registry Windows (User rồi Machine). Chỉ gọi khi PATH của process không có. */
  registryPath?: () => Promise<string[]>;
}

const fileExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Thư mục các trình cài hay đặt binary, ngoài PATH. */
export function knownDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? '';
    const home = env.USERPROFILE ?? '';
    const programData = env.ProgramData ?? 'C:\\ProgramData';
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return [
      local && path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(programData, 'chocolatey', 'bin'),
      home && path.join(home, 'scoop', 'shims'),
      path.join(programFiles, 'nodejs'),
      path.join(programFiles, 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin',
    ].filter(Boolean);
  }
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  return ['/usr/local/bin', '/usr/bin', '/snap/bin', path.posix.join(env.HOME ?? '', '.local', 'bin')];
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(platform === 'win32' ? ';' : ':').map((d) => d.trim()).filter(Boolean);
}

/** Ghép đường dẫn theo quy ước của platform đang xét (test chạy trên Windows vẫn ra /opt/homebrew/bin/ffplay). */
const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

function candidates(name: string, dir: string, platform: NodeJS.Platform): string[] {
  const p = pathFor(platform);
  if (platform !== 'win32') return [p.join(dir, name)];
  const exts = p.extname(name) ? [''] : ['.exe', '.cmd', '.bat', ''];
  return exts.map((ext) => p.join(dir, name + ext));
}

/**
 * Trả đường dẫn tuyệt đối của `name` (tên trần hay đường dẫn), hoặc undefined nếu không thấy ở đâu.
 * Thứ tự: PATH của process, PATH trong registry (Windows), thư mục quen thuộc. Không đụng registry khi PATH đã có.
 */
export async function findExecutable(name: string, deps: FindDeps = {}): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fileExists;
  if (pathFor(platform).isAbsolute(name)) return exists(name) ? name : undefined;
  const search = (dirs: string[]): string | undefined => {
    for (const dir of dirs) {
      const hit = candidates(name, dir, platform).find(exists);
      if (hit) return hit;
    }
    return undefined;
  };
  const inPath = search(pathDirs(env, platform));
  if (inPath) return inPath;
  if (platform === 'win32') {
    const fromRegistry = search(await (deps.registryPath ?? readRegistryPath)());
    if (fromRegistry) return fromRegistry;
  }
  return search(knownDirs(platform, env));
}

/** Thay %VAR% bằng giá trị trong env; biến không có thì để nguyên. */
export function expandEnv(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(/%([^%]+)%/g, (m, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key !== undefined && env[key] !== undefined ? env[key] : m;
  });
}

/** Lấy các thư mục từ output `reg query ... /v Path` (REG_SZ hay REG_EXPAND_SZ). */
export function parseRegistryPath(output: string, env: NodeJS.ProcessEnv): string[] {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  if (!m) return [];
  return expandEnv(m[1].trim(), env).split(';').map((d) => d.trim()).filter(Boolean);
}

const REGISTRY_KEYS = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];

/** PATH của User rồi Machine trong registry Windows; lỗi hay không phải Windows thì rỗng. */
export function readRegistryPath(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const query = (key: string) =>
    new Promise<string[]>((resolve) => {
      try {
        execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
          resolve(err ? [] : parseRegistryPath(stdout, env));
        });
      } catch {
        resolve([]);
      }
    });
  return Promise.all(REGISTRY_KEYS.map(query)).then((lists) => lists.flat());
}

/**
 * Cho hook: --player là tên trần hay đường dẫn đã ghi mà không còn tồn tại thì tìm lại (theo tên file);
 * không thấy thì trả nguyên để lỗi spawn vẫn nói đúng tên. Đường dẫn còn tồn tại thì dùng ngay, không tra gì.
 */
export async function resolvePlayer(player: string, deps: FindDeps = {}): Promise<string> {
  const exists = deps.exists ?? fileExists;
  const p = pathFor(deps.platform ?? process.platform);
  if (p.isAbsolute(player) && exists(player)) return player;
  const name = p.isAbsolute(player) ? p.basename(player) : player;
  return (await findExecutable(name, deps)) ?? player;
}
