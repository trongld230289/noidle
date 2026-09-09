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

export function listAudioDevices(ffmpegPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        // ffmpeg thoát với mã lỗi sau khi liệt kê; chỉ coi là lỗi khi không chạy được.
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`Không tìm thấy ffmpeg tại "${ffmpegPath}". Cài bằng: winget install Gyan.FFmpeg, rồi mở lại VS Code.`));
          return;
        }
        resolve(parseAudioDevices(String(stderr ?? '')));
      },
    );
  });
}
