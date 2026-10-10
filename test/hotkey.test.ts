import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { watchHotkey } from '../src/native';

// F24: không bàn phím nào có, test không giành phím thật của người đang dùng máy.
const VK_F24 = 0x87;

function press(vk: number): void {
  const script = `Add-Type -Name K -Namespace T -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
[T.K]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero); [T.K]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

const waitFor = (p: () => boolean, ms: number) =>
  new Promise<boolean>((resolve) => {
    const t0 = Date.now();
    const tick = () => (p() ? resolve(true) : Date.now() - t0 > ms ? resolve(false) : setTimeout(tick, 50));
    tick();
  });

describe.runIf(process.platform === 'win32')('watchHotkey', () => {
  it('báo khi bấm phím dù cửa sổ nào đang foreground, nhả phím khi dừng', async () => {
    let ready = false;
    let presses = 0;
    const release = watchHotkey(() => presses++, { vk: VK_F24, onReady: () => (ready = true) });
    try {
      expect(await waitFor(() => ready, 25_000)).toBe(true);
      press(VK_F24);
      expect(await waitFor(() => presses === 1, 3000)).toBe(true);
    } finally {
      release();
    }
    // Đã nhả: một watcher mới giữ lại được cùng phím (không "busy").
    let again = '';
    const release2 = watchHotkey(() => undefined, { vk: VK_F24, onReady: () => (again = 'ready'), onBusy: () => (again = 'busy') });
    try {
      expect(await waitFor(() => again !== '', 25_000)).toBe(true);
      expect(again).toBe('ready');
    } finally {
      release2();
    }
  });

  it('phím đang bị giữ thì báo busy', async () => {
    let first = false;
    let second = '';
    const release = watchHotkey(() => undefined, { vk: VK_F24, onReady: () => (first = true) });
    try {
      expect(await waitFor(() => first, 25_000)).toBe(true);
      const release2 = watchHotkey(() => undefined, { vk: VK_F24, onReady: () => (second = 'ready'), onBusy: () => (second = 'busy') });
      try {
        expect(await waitFor(() => second !== '', 25_000)).toBe(true);
        expect(second).toBe('busy');
      } finally {
        release2();
      }
    } finally {
      release();
    }
  });
});
