import { describe, it, expect } from 'vitest';
import { ancestorsOf, parentMap, parseParentTable, pickTerminal, terminalForAgent, agentInWindow, anchorIndex, agentChainFrom, isWrapperExe, parseProcTable, procChain, type ProcEntry } from '../src/proctree';

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

describe('agentInWindow', () => {
  const term = (name: string, pid: number | undefined) => ({ name, processId: Promise.resolve(pid) });
  it('Copilot Chat: hook là con của extension host, nên pid extension host nằm trong chuỗi tổ tiên', async () => {
    // hook node → powershell → extension host (4321) → Code chính
    expect(await agentInWindow([100, 99, 4321, 10], 4321, [])).toBe(true);
  });
  it('Claude Code / Copilot CLI: một terminal của cửa sổ có shell pid trong chuỗi', async () => {
    expect(await agentInWindow([100, 90, 80, 70, 60], 4321, [term('a', 111), term('b', 70)])).toBe(true);
  });
  it('không phải extension host của mình, không terminal nào khớp: không phải cửa sổ này', async () => {
    expect(await agentInWindow([100, 90, 80, 70, 60], 4321, [term('a', 111)])).toBe(false);
  });
  it('không có chuỗi tổ tiên thì không nhận', async () => {
    expect(await agentInWindow([], 4321, [term('a', 111)])).toBe(false);
    expect(await agentInWindow(undefined, 4321, [term('a', 111)])).toBe(false);
  });
});

describe('neo của chuỗi pid: tiến trình agent, bỏ các shell bọc hook', () => {
  // 3/10/2026: Claude Code chạy hook qua bash.exe -c → bash.exe → node; ppid của hook là bash tạm, mỗi lần một pid khác.
  const chain: ProcEntry[] = [
    { pid: 1, exe: 'bash.exe' }, { pid: 2, exe: 'bash.exe' }, { pid: 3, exe: 'claude.exe' },
    { pid: 4, exe: 'powershell.exe' }, { pid: 5, exe: 'code.exe' }, { pid: 6, exe: 'code.exe' }, { pid: 7, exe: 'explorer.exe' },
  ];
  it('shell và conhost là vỏ bọc, kể cả tên không có .exe (macOS)', () => {
    for (const e of ['bash.exe', 'sh', 'zsh', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'BASH.EXE']) expect(isWrapperExe(e)).toBe(true);
    for (const e of ['claude.exe', 'node.exe', 'code.exe', 'copilot', 'node']) expect(isWrapperExe(e)).toBe(false);
  });
  it('neo là pid đầu tiên không phải vỏ bọc; chuỗi từ neo trở lên là chuỗi của agent', () => {
    expect(anchorIndex(chain)).toBe(2);
    expect(agentChainFrom(chain)).toEqual([3, 4, 5, 6, 7]);
  });
  it('Copilot Chat: hook ← powershell ← extension host; neo là extension host', () => {
    const chat: ProcEntry[] = [{ pid: 10, exe: 'powershell.exe' }, { pid: 11, exe: 'code.exe' }, { pid: 12, exe: 'code.exe' }];
    expect(agentChainFrom(chat)).toEqual([11, 12]);
  });
  it('toàn vỏ bọc hay rỗng thì giữ nguyên chuỗi (không biết neo, còn hơn mất)', () => {
    expect(agentChainFrom([{ pid: 1, exe: 'bash.exe' }])).toEqual([1]);
    expect(agentChainFrom([])).toEqual([]);
  });
});

describe('bảng tiến trình POSIX "pid ppid comm"', () => {
  it('đọc ba cột, bỏ dòng rác; procChain trả pid rồi cha với tên lệnh', () => {
    const t = parseProcTable(' 100 90 node\n90 80 sh\n80 1 zsh\nPID PPID COMM\n');
    expect(t.get(100)).toEqual({ pid: 100, ppid: 90, exe: 'node' });
    expect(procChain(100, t)).toEqual([{ pid: 100, exe: 'node' }, { pid: 90, exe: 'sh' }, { pid: 80, exe: 'zsh' }]);
    expect(procChain(100, t, 2)).toHaveLength(2);
  });
});
