import { defineConfig } from 'vitest/config';
import * as os from 'os';
import * as path from 'path';
// VI_VOICE_HOST_FLASH=0: test chạy hook như tiến trình con dưới terminal thật; hook không được nháy terminal đó.
// NOIDLE_NATIVE_DIR: mỗi file test đổi TEMP riêng, nên trỏ DLL native về một chỗ chung để chỉ biên dịch C# một lần.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Test hook spawn node + PowerShell (tra chuỗi pid, tách tiến trình play qua Start-Process) vài lần mỗi test; chạy 6 file
    // song song thì 15 giây không đủ (hook-auto: 6,6 giây khi chạy riêng, quá 15 giây khi chạy cả bộ).
    testTimeout: 30_000,
    env: { VI_VOICE_HOST_FLASH: '0', NOIDLE_NATIVE_DIR: path.join(os.tmpdir(), 'noidle-tts', 'native') },
  },
});
