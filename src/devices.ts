import { execFile } from 'child_process';

/** Lấy tên thân thiện của các thiết bị audio từ stderr của `ffmpeg -list_devices true -f dshow -i dummy`. */
export function parseAudioDevices(stderr: string): string[] {
  const names: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s+\(audio\)\s*$/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

/** Lấy tên micro từ stderr của `ffmpeg -f avfoundation -list_devices true -i ""` (macOS): các dòng "[n] tên" sau "audio devices:". */
export function parseAvfoundationDevices(stderr: string): string[] {
  const names: string[] = [];
  let audio = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation video devices:/i.test(line)) audio = false;
    else if (/AVFoundation audio devices:/i.test(line)) audio = true;
    else if (audio) {
      const m = /\]\s*\[(\d+)\]\s+(.+?)\s*$/.exec(line);
      if (m) names.push(m[2]);
    }
  }
  return names;
}

/** Câu hướng dẫn cài ffmpeg theo hệ điều hành. */
export function ffmpegInstallHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'brew install ffmpeg' : 'winget install Gyan.FFmpeg';
}

/**
 * Tham số input của ffmpeg để thu mic: dshow trên Windows, avfoundation trên macOS.
 * macOS không chọn micro thì dùng "default", tức micro mặc định trong System Settings (AirPods, tai nghe... đổi theo máy).
 */
export function micInputArgs(device: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['-f', 'avfoundation', '-i', `:${device || 'default'}`];
  return ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${device}`];
}

export function listAudioDevices(ffmpegPath: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const mac = platform === 'darwin';
  const args = mac
    ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
    : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { windowsHide: true }, (err, _stdout, stderr) => {
      // ffmpeg thoát với mã lỗi sau khi liệt kê; chỉ coi là lỗi khi không chạy được.
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Không tìm thấy ffmpeg tại "${ffmpegPath}". Cài bằng: ${ffmpegInstallHint(platform)}, rồi mở lại VS Code.`));
        return;
      }
      const out = String(stderr ?? '');
      resolve(mac ? parseAvfoundationDevices(out) : parseAudioDevices(out));
    });
  });
}
