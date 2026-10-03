import { describe, it, expect } from 'vitest';
import { NATIVE_SOURCE, nativeDllPath, nativeScript, parseChain, runPowerShell } from '../src/native';

describe('native: helper C# biên dịch một lần thành DLL', () => {
  it('tên DLL mang hash của mã nguồn, đổi mã là đổi tên', () => {
    const p = nativeDllPath('C:/t');
    expect(p).toMatch(/noidle-native-[0-9a-f]{10}\.dll$/);
    expect(nativeDllPath('C:/t')).toBe(p);
  });
  it('script nạp DLL nếu có, không thì biên dịch ra file tạm rồi đổi tên, lỗi thì Add-Type trong bộ nhớ', () => {
    const s = nativeScript('exit 0', 'C:/t');
    expect(s).toContain('Add-Type -Path');
    expect(s).toContain('-OutputAssembly');
    expect(s).toContain('Move-Item');
    expect(s).toContain('Add-Type -TypeDefinition $src');
    expect(s).toContain(NATIVE_SOURCE.slice(0, 40));
    expect(s.trim().endsWith('exit 0')).toBe(true);
  });
  it('mã C# có đủ các hàm hook và extension cần', () => {
    for (const fn of ['Chain(', 'HostFlash(', 'FlashWindow(', 'Foreground(', 'TitleMatches(']) expect(NATIVE_SOURCE).toContain(fn);
  });
  it('parseChain đọc các dòng "chain<tab>pid<tab>exe", bỏ dòng khác', () => {
    expect(parseChain('chain\t12\tbash.exe\r\nchain\t34\tclaude.exe\nchosen\tpid 1 x\n')).toEqual([
      { pid: 12, exe: 'bash.exe' },
      { pid: 34, exe: 'claude.exe' },
    ]);
    expect(parseChain('')).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('native (thật, Windows)', () => {
  it('Chain từ pid của test trả về chính nó rồi cha của nó', async () => {
    const r = await runPowerShell(nativeScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[NoIdleNative]::Chain(${process.pid}, 6) | ForEach-Object { [Console]::Out.WriteLine("chain\`t" + $_) }
exit 0`), 'test-chain');
    expect(r.code).toBe(0);
    const chain = parseChain(r.out);
    expect(chain[0]?.pid).toBe(process.pid);
    expect(chain[1]?.pid).toBe(process.ppid);
    expect(chain[0]?.exe.toLowerCase()).toBe('node.exe');
  }, 60_000);
});
