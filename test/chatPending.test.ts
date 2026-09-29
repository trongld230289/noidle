import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPendingTracker, commandMatches, isAgentTerminal, type PendingChatTool } from '../src/chatPending';

// Copilot Chat gọi hook PreToolUse trước cả tool sẽ tự duyệt và không báo khi hộp duyệt hiện. Extension chờ một lát:
// có bằng chứng tool đã chạy (terminal Copilot mở, lệnh bắt đầu chạy, PostToolUse) thì im; hết giờ thì mới đọc.
describe('ChatPendingTracker', () => {
  const announced: PendingChatTool[] = [];
  let tracker: ChatPendingTracker;
  const pending = (over: Partial<PendingChatTool> = {}): PendingChatTool => ({
    session: 'chat-1', toolUseId: 'call_1__vscode-1', command: 'git push origin main', text: 'Workspace x needs approval. Bash: git push.', ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    announced.length = 0;
    tracker = new ChatPendingTracker({ waitMs: 2500, onAnnounce: (p) => announced.push(p) });
  });
  afterEach(() => vi.useRealTimers());

  it('announces once the wait passes without evidence the tool ran', () => {
    tracker.add(pending());
    vi.advanceTimersByTime(2499);
    expect(announced).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(announced).toEqual([pending()]);
    expect(tracker.size).toBe(0);
  });

  it('stays silent when the tool finished before the wait passes', () => {
    tracker.add(pending());
    tracker.done({ toolUseId: 'call_1__vscode-1' });
    vi.advanceTimersByTime(5000);
    expect(announced).toEqual([]);
  });

  it('matches a finished tool by session and command when the id is missing', () => {
    tracker.add(pending());
    tracker.done({ session: 'chat-1', command: 'git push origin main' });
    vi.advanceTimersByTime(5000);
    expect(announced).toEqual([]);
  });

  it('stays silent when a Copilot terminal opens', () => {
    tracker.add(pending());
    tracker.terminalOpened(false);
    tracker.terminalOpened(true);
    vi.advanceTimersByTime(5000);
    expect(announced).toEqual([]);
  });

  it('ignores a terminal the user opened by hand', () => {
    tracker.add(pending());
    tracker.terminalOpened(false);
    vi.advanceTimersByTime(5000);
    expect(announced).toHaveLength(1);
  });

  it('stays silent when the pending command starts running in any terminal', () => {
    tracker.add(pending());
    tracker.add(pending({ toolUseId: 'call_2__vscode-1', command: 'npm test' }));
    tracker.executionStarted('git push origin main', false);
    vi.advanceTimersByTime(5000);
    expect(announced.map((p) => p.command)).toEqual(['npm test']);
  });

  it('treats any command starting in a Copilot terminal as evidence', () => {
    tracker.add(pending());
    tracker.executionStarted('cd /repo && git push origin main', true);
    vi.advanceTimersByTime(5000);
    expect(announced).toEqual([]);
  });

  it('drops the pending tools of a session once the user sends a new prompt', () => {
    tracker.add(pending());
    tracker.add(pending({ session: 'chat-2', toolUseId: 'call_9__vscode-1' }));
    tracker.promptSubmitted('chat-1');
    vi.advanceTimersByTime(5000);
    expect(announced.map((p) => p.session)).toEqual(['chat-2']);
  });

  it('replaces a pending tool re-sent with the same id and restarts its wait', () => {
    tracker.add(pending());
    vi.advanceTimersByTime(2000);
    tracker.add(pending());
    vi.advanceTimersByTime(2000);
    expect(announced).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(announced).toHaveLength(1);
  });

  it('clear() cancels everything', () => {
    tracker.add(pending());
    tracker.clear();
    vi.advanceTimersByTime(5000);
    expect(announced).toEqual([]);
  });
});

describe('commandMatches', () => {
  it.each([
    ['git push origin main', 'git push origin main', true],
    ['git  push   origin main', 'git push origin main\n', true],
    ['git push origin main', 'git push', false],
    ['npm test', 'npm test -- --run', true],
    ['npm test', 'npm', false],
    ['', 'git status', false],
  ])('%j vs %j → %s', (pending, line, expected) => {
    expect(commandMatches(pending, line)).toBe(expected);
  });
});

describe('isAgentTerminal', () => {
  it('recognises the environment Copilot Chat gives its terminals', () => {
    expect(isAgentTerminal({ env: { COPILOT_AGENT: '1' } })).toBe(true);
    expect(isAgentTerminal({ env: { AI_AGENT: 'github_copilot_vscode_agent' } })).toBe(true);
    expect(isAgentTerminal({ env: { PATH: 'x' }, name: 'pwsh' })).toBe(false);
    expect(isAgentTerminal({})).toBe(false);
    expect(isAgentTerminal(undefined)).toBe(false);
  });
});
