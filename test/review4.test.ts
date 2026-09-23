import { describe, it, expect } from 'vitest';
import { voiceApprovable, shellArgs } from '../src/decision';

/** Review lần bốn (22/9/2026): kiểm tra trên đối số thật sau khi bỏ nháy như shell, theo quy tắc từng lệnh. */

describe('shellArgs splits like a shell and rejects anything it cannot read safely', () => {
  it('strips quotes and keeps quoted spaces', () => {
    expect(shellArgs('git commit -m "feat: x y"')).toEqual(['git', 'commit', '-m', 'feat: x y']);
    expect(shellArgs("grep -rn 'a b' src")).toEqual(['grep', '-rn', 'a b', 'src']);
    expect(shellArgs('find . -type f "-delete"')).toEqual(['find', '.', '-type', 'f', '-delete']);
    expect(shellArgs('  ls   -la  ')).toEqual(['ls', '-la']);
  });
  it('returns undefined for unbalanced quotes, shell metacharacters or line breaks', () => {
    for (const c of ['echo "a', "echo 'a", 'echo $HOME', 'echo `id`', 'cat a > b', 'cat < a', 'echo a\nrm b', 'ls (x)', 'ls {a,b}', 'echo a\\ b', 'echo "$(x)"']) {
      expect(shellArgs(c), JSON.stringify(c)).toBeUndefined();
    }
  });
});

describe('voiceApprovable checks real arguments per command', () => {
  it('rejects quoted or split flags that still delete or force', () => {
    for (const c of [
      'find . -type f "-delete"', "find . '-exec' rm {} ;", 'git branch "-D" topic', "git branch '-f' main HEAD~1", 'git commit -m "x" "--amend"', 'git commit "--no-verify" -m x',
      'npm run "deploy"', 'npm "install" evil-pkg', 'make "deploy"', 'git "push"', 'git stash drop', 'git stash pop', 'git remote add x y', 'git branch new-branch',
      'echo "a; rm b"', 'cat "file|x"', 'ls "$(rm x)"',
    ]) {
      expect(voiceApprovable('Bash', { command: c }), JSON.stringify(c)).toBe(false);
    }
  });
  it('still allows ordinary safe commands with quoted arguments', () => {
    for (const c of [
      'git commit -m "feat: thêm hub"', "git commit -am 'x'", 'git commit --message="x y"', 'grep -rn "TODO: x" src', 'find src -name "*.ts"', 'echo "hello world"',
      'npm run test:unit -- --run', 'npx vitest run "test/a b.test.ts"', 'git log --oneline -n 5', 'git stash list', 'git remote -v', 'git branch --list', 'git branch -a -v',
      'ls -la "my dir"', 'cat "read me.md"',
    ]) {
      expect(voiceApprovable('Bash', { command: c }), c).toBe(true);
    }
  });
});
