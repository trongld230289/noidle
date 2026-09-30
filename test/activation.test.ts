import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('activation', () => {
  it('activates with the startup wave ("*"), not onStartupFinished', () => {
    // 30/9/2026: after a reboot the title bar stayed green for ~100 s. The tint lives in the workspace settings on disk,
    // so a window closed while it needed the user reopens green until this extension runs and removes it. With
    // onStartupFinished the extension host queued NoIdle behind every other extension (21:02:47 window painted,
    // 21:04:27 NoIdle activated); "*" extensions ran at 21:02:55.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.activationEvents).toEqual(['*']);
  });
});
