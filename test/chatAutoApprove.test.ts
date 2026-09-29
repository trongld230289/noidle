import { describe, expect, it } from 'vitest';
import { chatAutoApproveFrom, chatWouldAutoApprove, type ChatAutoApprove } from '../src/chatAutoApprove';

// Quy tắc auto-approve của VS Code (chat.tools.terminal.autoApprove): khoá thường = tiền tố lệnh,
// khoá /.../ = regex, false = cấm, null = bỏ quy tắc, { approve, matchCommandLine } = so cả dòng lệnh.
const rules: ChatAutoApprove = {
  rules: {
    'git status': true,
    echo: true,
    ls: true,
    rm: false,
    '/^npm\\s+(ls|list)\\b/': true,
    '/\\.ps1/i': { approve: false, matchCommandLine: true },
    'npm ci': null,
  },
};

describe('chatWouldAutoApprove', () => {
  it('is unknown without any rules', () => {
    expect(chatWouldAutoApprove('git status', undefined)).toBeUndefined();
    expect(chatWouldAutoApprove('git status', {})).toBeUndefined();
  });

  it('approves everything when the global switch is on', () => {
    expect(chatWouldAutoApprove('rm -rf /', { global: true })).toBe(true);
    expect(chatWouldAutoApprove('rm -rf /', { global: true, rules: { rm: false } })).toBe(true);
  });

  it('approves nothing when terminal auto-approve is disabled', () => {
    expect(chatWouldAutoApprove('git status', { ...rules, terminalEnabled: false })).toBe(false);
  });

  it.each([
    ['git status', true],
    ['git status --short', true],
    ['git statusx', false],
    ['git push origin main', false],
    ['echo hi && ls -la', true],
    ['echo hi; git push', false],
    ['ls | grep foo', false],
    ['npm ls', true],
    ['npm list --depth=0', true],
    ['npm ci', false],
    ['rm -rf dist', false],
    ['echo ok && rm -rf dist', false],
    ['echo run script.ps1', false],
    ['', false],
  ])('matches VS Code rules for %j', (command, expected) => {
    expect(chatWouldAutoApprove(command, rules)).toBe(expected);
  });
});

describe('chatAutoApproveFrom', () => {
  const settings: Record<string, unknown> = {
    'chat.tools.global.autoApprove': false,
    'chat.tools.terminal.enableAutoApprove': true,
    'chat.tools.terminal.ignoreDefaultAutoApproveRules': false,
    'chat.tools.terminal.autoApprove': { echo: true, 'npm test': true, rm: false },
  };
  const defaults: Record<string, unknown> = {
    'chat.tools.terminal.autoApprove': { echo: true, rm: false },
  };
  const read = (over: Record<string, unknown> = {}) => chatAutoApproveFrom(
    (key) => (key in over ? over[key] : settings[key]),
    (key) => defaults[key],
  );

  it('copies the merged VS Code settings', () => {
    expect(read()).toEqual({
      global: false,
      terminalEnabled: true,
      rules: { echo: true, 'npm test': true, rm: false },
    });
  });

  it('drops the built-in rules when the user ignores them', () => {
    expect(read({ 'chat.tools.terminal.ignoreDefaultAutoApproveRules': true }).rules).toEqual({ 'npm test': true });
  });

  it('keeps a built-in key the user overrode', () => {
    const over = { 'chat.tools.terminal.ignoreDefaultAutoApproveRules': true, 'chat.tools.terminal.autoApprove': { echo: false, rm: false } };
    expect(read(over).rules).toEqual({ echo: false });
  });

  it('tolerates missing or malformed settings', () => {
    expect(chatAutoApproveFrom(() => undefined, () => undefined)).toEqual({ global: false, terminalEnabled: true, rules: {} });
    expect(chatAutoApproveFrom(() => 'junk', () => undefined)).toEqual({ global: false, terminalEnabled: true, rules: {} });
  });
});
