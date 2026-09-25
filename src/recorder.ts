import { spawn, ChildProcess } from 'child_process';
import { listAudioDevices, micInputArgs, ffmpegInstallHint } from './devices';
import { pcmToWav } from './wav';

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * 2;
/** macOS chặn mic tới khi người dùng cho phép; ffmpeg chạy dưới VS Code nên quyền nằm ở mục Visual Studio Code. */
const MAC_MIC_HINT = process.platform === 'darwin' ? ' Kiểm tra quyền mic: System Settings > Privacy & Security > Microphone, bật cho Visual Studio Code rồi mở lại VS Code.' : '';

export interface RecorderOptions {
  ffmpegPath: string;
  /** Tên micro (dshow trên Windows, avfoundation trên macOS); bỏ trống thì lấy micro đầu tiên, macOS lấy micro mặc định. */
  device?: string;
  /** Tự tắt ffmpeg sau khoảng này không ghi (ms). */
  idleMs?: number;
  /** Ghi thêm một chút sau khi bấm dừng để không cắt từ cuối (ms). */
  tailMs?: number;
}

/**
 * Thu mic bằng ffmpeg (dshow trên Windows, avfoundation trên macOS) chạy nền. ffmpeg mở một lần và giữ chạy vì mở mic mất ~2s;
 * lúc rảnh dữ liệu bị bỏ, lúc ghi thì gom lại. Tự tắt sau idleMs.
 */
export class Recorder {
  private proc: ChildProcess | undefined;
  private ready: Promise<void> | undefined;
  private chunks: Buffer[] = [];
  private _recording = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private device: string | undefined;

  constructor(private readonly opts: RecorderOptions) {
    this.device = opts.device || undefined;
  }

  get recording(): boolean {
    return this._recording;
  }

  private onData: ((chunk: Uint8Array) => void) | undefined;

  /** Bắt đầu ghi. onData (tuỳ chọn) nhận PCM s16le live trong lúc ghi. */
  async start(onData?: (chunk: Uint8Array) => void): Promise<void> {
    if (this._recording) return;
    clearTimeout(this.idleTimer);
    await this.ensureProcess();
    this.chunks = [];
    this.onData = onData;
    this._recording = true;
  }

  async stop(): Promise<Uint8Array> {
    if (!this._recording) throw new Error('Chưa bắt đầu ghi');
    await new Promise((r) => setTimeout(r, this.opts.tailMs ?? 300));
    this._recording = false;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.scheduleIdleStop();
    return pcmToWav(new Uint8Array(pcm), SAMPLE_RATE, CHANNELS);
  }

  /** Thời lượng audio (ms) ứng với số byte WAV trả về từ stop(). */
  static durationMs(wav: Uint8Array): number {
    return Math.max(0, ((wav.byteLength - 44) / BYTES_PER_SEC) * 1000);
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.killProcess();
  }

  private scheduleIdleStop(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.killProcess(), this.opts.idleMs ?? 10 * 60_000);
  }

  private killProcess(): void {
    const p = this.proc;
    this.proc = undefined;
    this.ready = undefined;
    this._recording = false;
    if (p && p.exitCode === null) p.kill();
  }

  private async ensureProcess(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    if (!this.device && process.platform !== 'darwin') {
      const devices = await listAudioDevices(this.opts.ffmpegPath);
      if (devices.length === 0) throw new Error('ffmpeg không thấy micro nào (dshow). Kiểm tra mic đã cắm và bật trong Windows.');
      this.device = devices[0];
    }
    const args = [
      '-hide_banner', '-loglevel', 'info', '-nostdin',
      ...micInputArgs(this.device),
      '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-flush_packets', '1', 'pipe:1',
    ];
    const proc = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    let stderrTail = '';
    proc.stdout!.on('data', (d: Buffer) => {
      if (!this._recording) return;
      this.chunks.push(d);
      this.onData?.(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    });
    proc.stderr!.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.ready = undefined;
        this._recording = false;
      }
    });

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => done(new Error(`ffmpeg không mở được mic sau 10s. ${lastLine(stderrTail)}${MAC_MIC_HINT}`)), 10_000);
      proc.stdout!.once('data', () => done());
      proc.on('error', (e: NodeJS.ErrnoException) => {
        done(new Error(
          e.code === 'ENOENT'
            ? `Không tìm thấy ffmpeg tại "${this.opts.ffmpegPath}". Cài bằng: ${ffmpegInstallHint()}, rồi mở lại VS Code.`
            : `Không chạy được ffmpeg: ${e.message}`,
        ));
      });
      proc.on('exit', (code) => done(new Error(`ffmpeg thoát sớm (mã ${code}). ${lastLine(stderrTail)}${MAC_MIC_HINT}`)));
    });
    try {
      await this.ready;
    } catch (err) {
      this.killProcess();
      throw err;
    }
  }
}

function lastLine(s: string): string {
  const lines = s.trim().split(/\r?\n/).filter((l) => l.trim() && !/^\s*size=/.test(l));
  return lines[lines.length - 1] ?? '';
}
