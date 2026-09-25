import { describe, it, expect } from 'vitest';
import { parseAvfoundationDevices, micInputArgs, ffmpegInstallHint } from '../src/devices';
import { blinkTitleBar } from '../src/attention';

const avf = `
[AVFoundation indev @ 0x7f8b5c004a00] AVFoundation video devices:
[AVFoundation indev @ 0x7f8b5c004a00] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8b5c004a00] [1] Capture screen 0
[AVFoundation indev @ 0x7f8b5c004a00] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8b5c004a00] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7f8b5c004a00] [1] AirPods Pro của Trọng
: Input/output error
`;

describe('macOS: micro qua avfoundation', () => {
  it('chỉ lấy micro, bỏ camera và màn hình, giữ thứ tự', () => {
    expect(parseAvfoundationDevices(avf)).toEqual(['MacBook Pro Microphone', 'AirPods Pro của Trọng']);
  });
  it('không có micro thì rỗng', () => {
    expect(parseAvfoundationDevices('[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] Cam\n')).toEqual([]);
  });
  it('input avfoundation: chưa chọn micro thì dùng micro mặc định của máy', () => {
    expect(micInputArgs(undefined, 'darwin')).toEqual(['-f', 'avfoundation', '-i', ':default']);
    expect(micInputArgs('AirPods Pro', 'darwin')).toEqual(['-f', 'avfoundation', '-i', ':AirPods Pro']);
  });
  it('Windows giữ nguyên dshow', () => {
    expect(micInputArgs('Headset Mic (USB)', 'win32')).toEqual(['-f', 'dshow', '-audio_buffer_size', '50', '-i', 'audio=Headset Mic (USB)']);
  });
  it('hướng dẫn cài ffmpeg theo hệ điều hành', () => {
    expect(ffmpegInstallHint('darwin')).toBe('brew install ffmpeg');
    expect(ffmpegInstallHint('win32')).toContain('winget');
  });
});

describe('macOS: nháy title bar', () => {
  const make = (cancelAfter = Infinity) => {
    const calls: string[] = [];
    let n = 0;
    return {
      calls,
      deps: {
        on: async () => { calls.push('on'); n++; },
        off: async () => { calls.push('off'); },
        wait: async () => undefined,
        cancelled: () => n >= cancelAfter,
      },
    };
  };
  it('nháy đủ số lần rồi giữ màu khi hold', async () => {
    const { calls, deps } = make();
    expect(await blinkTitleBar(deps, true, { times: 3, halfMs: 0 })).toBe('done');
    expect(calls).toEqual(['off', 'on', 'off', 'on', 'off', 'on']);
  });
  it('không hold thì gỡ màu ở cuối', async () => {
    const { calls, deps } = make();
    await blinkTitleBar(deps, false, { times: 2, halfMs: 0 });
    expect(calls[calls.length - 1]).toBe('off');
  });
  it('người dùng quay về cửa sổ giữa chừng thì dừng và gỡ màu', async () => {
    const { calls, deps } = make(2);
    expect(await blinkTitleBar(deps, true, { times: 5, halfMs: 0 })).toBe('cancelled');
    expect(calls).toEqual(['off', 'on', 'off', 'on', 'off']);
  });
});
