import { describe, it, expect } from 'vitest';
import { ancestorsOf, parentMap, parseParentTable, pickTerminal, terminalForAgent } from '../src/proctree';

describe('parseParentTable', () => {
  it('đọc bảng "pid ppid" mỗi dòng, bỏ dòng rác và tiêu đề', () => {
    const m = parseParentTable('ProcessId ParentProcessId\n 10 1\n20  10 \n\nabc def\n30 20\n');
    expect(m.get(10)).toBe(1);
    expect(m.get(20)).toBe(10);
    expect(m.get(30)).toBe(20);
    expect(m.size).toBe(3);
  });
});

describe('ancestorsOf', () => {
  const tree = new Map<number, number>([
    [100, 90], // hook ← claude
    [90, 80], // claude ← cmd (claude.cmd)
    [80, 70], // cmd ← pwsh (shell của terminal)
    [70, 60], // pwsh ← ptyHost
    [60, 1],
  ]);
  it('trả về chính pid rồi lần lượt cha, ông...', () => {
    expect(ancestorsOf(100, tree)).toEqual([100, 90, 80, 70, 60, 1]);
  });
  it('dừng khi cha không có trong bảng', () => {
    expect(ancestorsOf(80, new Map([[80, 70]]))).toEqual([80, 70]);
  });
  it('không lặp vô hạn khi bảng có vòng (pid được tái sử dụng)', () => {
    const loop = new Map<number, number>([
      [5, 6],
      [6, 5],
    ]);
    expect(ancestorsOf(5, loop)).toEqual([5, 6]);
  });
  it('giới hạn độ sâu', () => {
    expect(ancestorsOf(100, tree, 3)).toEqual([100, 90, 80]);
  });
});

describe('parentMap (thật)', () => {
  it('tiến trình test có cha là pid thật của nó', async () => {
    const m = await parentMap();
    expect(m.get(process.pid)).toBe(process.ppid);
    expect(ancestorsOf(process.pid, m)).toContain(process.ppid);
  }, 15_000);
});

describe('pickTerminal', () => {
  const term = (name: string, pid: number | undefined) => ({ name, processId: Promise.resolve(pid) });
  it('chọn terminal có shell pid nằm trong danh sách tổ tiên', async () => {
    const a = term('a', 111);
    const b = term('b', 70);
    expect(await pickTerminal([a, b], [100, 90, 80, 70])).toBe(b);
  });

  describe('terminalForAgent', () => {
    const active = { name: 'unrelated shell', processId: Promise.resolve(10) };
    const cli = { name: 'CLI shell', processId: Promise.resolve(20) };

    it('pins CLI input to its process ancestry, even if another terminal is active', async () => {
      expect(await terminalForAgent([active, cli], [30, 20], active, 'copilot-cli')).toBe(cli);
    });
    it('never falls back to an unrelated terminal for an external CLI session', async () => {
      expect(await terminalForAgent([active], [30, 20], active, 'copilot-cli')).toBeUndefined();
      expect(await terminalForAgent([active], undefined, active, 'copilot-cli')).toBeUndefined();
    });
    it('preserves the existing Claude fallback', async () => {
      expect(await terminalForAgent([active], undefined, active, 'claude')).toBe(active);
    });
    it('Claude ở terminal ngoài VS Code: không gõ vào terminal không liên quan', async () => {
      expect(await terminalForAgent([active], [30, 20], active, 'claude')).toBeUndefined();
      expect(await terminalForAgent([active, cli], [30, 20], active, 'claude')).toBe(cli);
    });
  });
  it('không khớp thì undefined', async () => {
    expect(await pickTerminal([term('a', 111)], [100, 90])).toBeUndefined();
    expect(await pickTerminal([term('a', 111)], undefined)).toBeUndefined();
    expect(await pickTerminal([], [111])).toBeUndefined();
  });
  it('bỏ qua terminal không có pid hoặc pid bị lỗi', async () => {
    const dead = { name: 'x', processId: Promise.reject(new Error('gone')) };
    const none = term('y', undefined);
    const ok = term('z', 70);
    expect(await pickTerminal([dead, none, ok], [70])).toBe(ok);
  });
});
