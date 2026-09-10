/** Mở mic bằng ffmpeg (dshow), thu cho đến khi người dùng nói xong một cụm, trả về WAV. Dùng trong hook. */
import { spawn } from 'child_process';
import { Segmenter } from './segmenter';
import { pcmToWav } from './wav';
import { listAudioDevices } from './devices';

export const SAMPLE_RATE = 16000;

export interface ListenOptions {
  ffmpegPath: string;
  /** Tên thiết bị dshow; bỏ trống thì lấy thiết bị đầu tiên. */
  device?: string;
  /** Tối đa chờ bao lâu (ms) kể cả lúc chưa ai nói. */
  maxMs: number;
  /** Ngắt hơi bao lâu (ms) sau khi nói thì coi là xong. */
  silenceMs?: number;
  log?: (msg: string) => void;
}

/** Thu một cụm tiếng nói. Trả về undefined nếu hết giờ mà không ai nói, hoặc không mở được mic. */
export async function listenOnce(opts: ListenOptions): Promise<Uint8Array | undefined> {
  let device = opts.device;
  if (!device) {
    const devices = await listAudioDevices(opts.ffmpegPath);
    device = devices[0];
    if (!device) {
      opts.log?.('ffmpeg không thấy micro nào');
      return undefined;
    }
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${device}`,
    '-t', String(Math.ceil(opts.maxMs / 1000) + 1),
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', '-flush_packets', '1', 'pipe:1',
  ];
  const proc = spawn(opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  return new Promise<Uint8Array | undefined>((resolve) => {
    let done = false;
    let stderr = '';
    const finish = (pcm?: Uint8Array) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (proc.exitCode === null) proc.kill();
      resolve(pcm ? pcmToWav(pcm, SAMPLE_RATE, 1) : undefined);
    };
    // Cụm tối đa dài bằng maxMs để một câu trả lời dài không bị cắt đôi.
    const segmenter = new Segmenter(
      { sampleRate: SAMPLE_RATE, silenceMs: opts.silenceMs ?? 1200, maxSegmentMs: opts.maxMs, minSpeechMs: 300 },
      (pcm) => finish(pcm),
    );
    const timer = setTimeout(() => {
      segmenter.flush();
      finish();
    }, opts.maxMs);
    proc.stdout!.on('data', (d: Buffer) => segmenter.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    proc.on('error', (e) => {
      opts.log?.(`không chạy được ffmpeg: ${e.message}`);
      finish();
    });
    proc.on('exit', (code) => {
      if (!done && code) opts.log?.(`ffmpeg thoát mã ${code}: ${stderr.trim()}`);
      segmenter.flush();
      finish();
    });
  });
}
