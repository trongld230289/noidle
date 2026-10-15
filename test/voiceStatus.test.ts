import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readVoiceStatus, writeVoiceStatus, voiceErrorHint } from '../src/voiceStatus';

const CERT = 'Edge TTS WebSocket error: unable to get local issuer certificate (code=UNABLE_TO_GET_ISSUER_CERT_LOCALLY)';

describe('voiceErrorHint: lời khuyên trên status bar khi không tải được giọng', () => {
  it('lỗi chứng chỉ mà Node đã đọc kho hệ thống: CA công ty không có trong kho, đặt NODE_EXTRA_CA_CERTS', () => {
    expect(voiceErrorHint(CERT, true)).toMatch(/certificate.*NODE_EXTRA_CA_CERTS/);
    expect(voiceErrorHint('Edge TTS WebSocket error: self-signed certificate in certificate chain (code=SELF_SIGNED_CERT_IN_CHAIN)', true)).toMatch(/NODE_EXTRA_CA_CERTS/);
  });
  it('lỗi chứng chỉ trên Node cũ: nói rõ phiên bản Node và bản cần cập nhật', () => {
    const hint = voiceErrorHint(CERT, false, 'v20.11.0');
    expect(hint).toContain('v20.11.0');
    expect(hint).toMatch(/22\.19.*24\.5/);
  });
  it('403: server từ chối, cập nhật NoIdle', () => {
    expect(voiceErrorHint('Edge TTS WebSocket error: Unexpected server response: 403', true)).toMatch(/403.*Update NoIdle/);
  });
  it('lỗi khác: kiểm tra mạng', () => {
    expect(voiceErrorHint('Edge TTS WebSocket error: getaddrinfo ENOTFOUND api.msedgeservices.com', true)).toMatch(/network/i);
  });
});

describe('voice-status.json: hook ghi, extension đọc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-voice-status-'));

  it('chỉ ghi khi đổi trạng thái hay đổi lỗi, lượt đọc bình thường không chạm file', () => {
    const file = path.join(dir, 'sub', 'voice-status.json');
    writeVoiceStatus({ ok: true, at: 1 }, file);
    expect(readVoiceStatus(file)).toEqual({ ok: true, at: 1 });
    writeVoiceStatus({ ok: true, at: 2 }, file);
    expect(readVoiceStatus(file)?.at).toBe(1);
    writeVoiceStatus({ ok: false, error: CERT, hint: 'h', at: 3 }, file);
    expect(readVoiceStatus(file)).toEqual({ ok: false, error: CERT, hint: 'h', at: 3 });
    writeVoiceStatus({ ok: false, error: CERT, hint: 'h', at: 4 }, file);
    expect(readVoiceStatus(file)?.at).toBe(3);
    writeVoiceStatus({ ok: false, error: 'other', hint: 'h', at: 5 }, file);
    expect(readVoiceStatus(file)?.at).toBe(5);
    writeVoiceStatus({ ok: true, at: 6 }, file);
    expect(readVoiceStatus(file)).toEqual({ ok: true, at: 6 });
  });

  it('thiếu file hay file hỏng: undefined', () => {
    expect(readVoiceStatus(path.join(dir, 'missing.json'))).toBeUndefined();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(readVoiceStatus(bad)).toBeUndefined();
    fs.writeFileSync(bad, JSON.stringify({ at: 1 }));
    expect(readVoiceStatus(bad)).toBeUndefined();
  });

  it('không ghi được (thư mục là file) thì bỏ qua, không ném lỗi làm hỏng lượt đọc', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() => writeVoiceStatus({ ok: true, at: 1 }, path.join(blocker, 'voice-status.json'))).not.toThrow();
  });
});
