import { defineConfig } from 'vitest/config';
// VI_VOICE_HOST_FLASH=0: test chạy hook như tiến trình con dưới terminal thật; hook không được nháy terminal đó.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], env: { VI_VOICE_HOST_FLASH: '0' } } });
