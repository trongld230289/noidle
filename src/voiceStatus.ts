/**
 * Lượt đọc gần nhất có ra tiếng không. Hook chạy trong tiến trình riêng nên lỗi tải giọng (mạng công ty chặn chứng chỉ, Edge
 * 403) trước đây chỉ nằm trong hook.log, người dùng tưởng loa hỏng (15/10/2026). Hook ghi file sau mỗi lượt đọc, extension
 * theo dõi file và hiện "no voice" trên status bar tới khi có lượt đọc ra tiếng.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface VoiceStatus {
  ok: boolean;
  /** Lượt hỏng: lỗi của câu hỏng đầu tiên, và lời khuyên tiếng Anh cho tooltip (status bar luôn tiếng Anh). */
  error?: string;
  hint?: string;
  at: number;
}

export function voiceStatusPath(): string {
  return path.join(os.tmpdir(), 'noidle-tts', 'voice-status.json');
}

export function readVoiceStatus(file = voiceStatusPath()): VoiceStatus | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as VoiceStatus;
    return typeof s.ok === 'boolean' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Chỉ ghi khi trạng thái hay lỗi đổi, để lượt đọc bình thường không chạm file. Không ghi được thì bỏ qua, không làm hỏng lượt đọc. */
export function writeVoiceStatus(s: VoiceStatus, file = voiceStatusPath()): void {
  const prev = readVoiceStatus(file);
  if (prev && prev.ok === s.ok && prev.error === s.error) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s));
  } catch {
    /* bỏ qua */
  }
}

/** Lời khuyên theo lỗi. systemCa: hook đã thêm được CA hệ thống (Node đủ mới, xem systemCa.ts). */
export function voiceErrorHint(error: string, systemCa: boolean, node = process.version): string {
  if (/CERT|certificate/i.test(error)) {
    return systemCa
      ? 'Your network re-signs HTTPS with a certificate the system does not trust. Set NODE_EXTRA_CA_CERTS to your company root certificate, then restart VS Code'
      : `Your network re-signs HTTPS and Node ${node} cannot read the system certificates. Update Node to 22.19+ or 24.5+, then restart VS Code`;
  }
  if (/\b403\b/.test(error)) return 'The voice server refused the request (403). Update NoIdle';
  return 'Could not reach the voice server. Check the network';
}
