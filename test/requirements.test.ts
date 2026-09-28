import { describe, it, expect } from 'vitest';
import { commandWorks, checkRequirements, type CommandRunner } from '../src/requirements';

const enoent = (cmd: string) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
const runnerWith = (available: string[]): CommandRunner => (cmd, _args, done) => {
  setImmediate(() => done(available.includes(cmd) ? null : enoent(cmd)));
};

describe('commandWorks', () => {
  it('true khi lệnh khởi động được', async () => {
    expect(await commandWorks('node', ['--version'], runnerWith(['node']))).toBe(true);
  });

  it('false khi không tìm thấy lệnh (ENOENT)', async () => {
    expect(await commandWorks('ffplay', ['-version'], runnerWith([]))).toBe(false);
  });

  it('true khi lệnh chạy nhưng thoát khác 0 (ffplay -version thoát 1 trên vài bản)', async () => {
    const run: CommandRunner = (_cmd, _args, done) => done(Object.assign(new Error('exit 1'), { code: 1 }));
    expect(await commandWorks('ffplay', ['-version'], run)).toBe(true);
  });

  it('false khi runner ném lỗi đồng bộ', async () => {
    const run: CommandRunner = () => {
      throw new Error('boom');
    };
    expect(await commandWorks('node', ['--version'], run)).toBe(false);
  });

  it('chạy thật: node có, lệnh bịa thì không', async () => {
    expect(await commandWorks('node', ['--version'])).toBe(true);
    expect(await commandWorks('noidle-no-such-command-xyz', ['--version'])).toBe(false);
  });
});

describe('checkRequirements', () => {
  it('báo từng thứ thiếu, kiểm tra player theo đường dẫn được cấu hình', async () => {
    const seen: string[] = [];
    const run: CommandRunner = (cmd, args, done) => {
      seen.push(`${cmd} ${args.join(' ')}`);
      done(cmd === 'node' ? null : enoent(cmd));
    };
    expect(await checkRequirements('C:/ffmpeg/bin/ffplay.exe', run)).toEqual({ node: true, player: false });
    expect(seen).toEqual(['node --version', 'C:/ffmpeg/bin/ffplay.exe -version']);
  });

  it('đủ cả hai', async () => {
    expect(await checkRequirements('ffplay', runnerWith(['node', 'ffplay']))).toEqual({ node: true, player: true });
  });
});
