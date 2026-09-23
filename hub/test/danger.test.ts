import { describe, it, expect } from 'vitest';
import { isDangerous, summarizeTool } from '../src/danger';

describe('isDangerous', () => {
  it('flags destructive shell commands, including options before the git verb and long rm flags', () => {
    for (const c of [
      'rm -rf dist', 'rm --recursive out', 'rm -R build', 'git push origin main', 'git -C repo push', 'git --no-pager reset --hard',
      'git clean -fd', 'git branch -D old', 'DROP TABLE users', 'delete from orders', 'del /s /q build', 'Remove-Item -Recurse x',
      'docker system prune', 'kubectl delete pod x', 'sudo apt install x', 'npm publish', 'shutdown /r',
    ]) {
      expect(isDangerous('Bash', { command: c }), c).toBe(true);
    }
  });
  it('allows ordinary commands and edits', () => {
    for (const c of ['npm test', 'git status && git diff', 'git commit -m x', 'ls -la', 'rm notes.txt']) expect(isDangerous('Bash', { command: c }), c).toBe(false);
    expect(isDangerous('Edit', { file_path: 'src/a.ts' })).toBe(false);
    expect(isDangerous('Read', { file_path: '.env' })).toBe(false);
    expect(isDangerous(undefined, {})).toBe(false);
  });
  it('flags writes to secrets, settings and git internals', () => {
    for (const f of ['C:/app/.env', '/srv/.env.production', '/home/u/.npmrc', '/home/u/.ssh/id_rsa', 'x/settings.json', 'C:/app/appsettings.Production.json', 'repo/.git/config', 'k.pem']) {
      expect(isDangerous('Write', { file_path: f }), f).toBe(true);
    }
  });
  it('flags tools that end things', () => {
    expect(isDangerous('KillShell', {})).toBe(true);
  });
});

describe('summarizeTool', () => {
  it('shows the command, the file, or a short JSON', () => {
    expect(summarizeTool('Bash', { command: 'npm test' })).toBe('npm test');
    expect(summarizeTool('Bash', { command: 'x'.repeat(200) })).toHaveLength(121);
    expect(summarizeTool('Edit', { file_path: 'src/a.ts', old_string: 'a' })).toBe('src/a.ts');
    expect(summarizeTool('WebFetch', { url: 'https://a' })).toBe('{"url":"https://a"}');
    expect(summarizeTool(undefined, undefined)).toBe('');
  });
});
