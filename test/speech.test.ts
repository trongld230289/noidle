import { describe, it, expect } from 'vitest';
import { lastAssistantText, pickSpeech, stripMarkdown, promptContext, promptReminder } from '../src/speech';
import { applyHooks, hookCommands } from '../src/claudeHooks';
import { splitSentences, announcement, workspaceName, doneAnnouncement } from '../src/speech';

const line = (o: unknown) => JSON.stringify(o);

describe('speech word separation instructions', () => {
  it.each(['vi', 'en'] as const)('guides AI word separation in full prompts (%s)', (lang) => {
    const instruction = promptContext(lang);
    expect(instruction).toContain('SuperAdmin');
    expect(instruction).toContain('Super Admin');
    expect(instruction).toContain('ShipNGo');
    expect(instruction).toContain('Ship N Go');
    expect(instruction).toContain('Shippo');
    expect(instruction).toContain(lang === 'vi' ? 'không chắc' : 'uncertain');
    expect(instruction.toLowerCase()).toContain(lang === 'vi' ? 'phần trả lời chính' : 'main answer');
  });

  it.each(['vi', 'en'] as const)('keeps the speech-only separation guidance in reminders (%s)', (lang) => {
    const instruction = promptReminder(lang);
    expect(instruction).toContain(lang === 'vi' ? 'theo nghĩa ở phần đọc' : 'by meaning in speech');
    expect(instruction).toContain(lang === 'vi' ? 'không chắc thì giữ nguyên' : 'uncertain names unchanged');
    expect(instruction).toContain(lang === 'vi' ? 'Phần chính giữ tên gốc' : 'original names in the main answer');
  });

  it('reads the AI-prepared section while preserving names in the main answer', () => {
    const response = 'SuperAdmin uses ShipNGo and Shippo.\n🔊 Super Admin uses Ship N Go and Shippo.';
    expect(pickSpeech(response)).toBe('Super Admin uses Ship N Go and Shippo.');
    expect(response.startsWith('SuperAdmin uses ShipNGo and Shippo.')).toBe(true);
  });
});

describe('lastAssistantText', () => {
  it('returns text blocks of the last assistant entry that has text', () => {
    const jsonl = [
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong.' }, { type: 'text', text: '🔊 Đã xong.' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      'garbage line',
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('Xong.\n🔊 Đã xong.');
  });
  it('returns empty when there is no assistant text', () => {
    expect(lastAssistantText('')).toBe('');
    expect(lastAssistantText(line({ type: 'user', message: { content: 'x' } }))).toBe('');
  });
});

describe('pickSpeech', () => {
  it('prefers lines marked with the speaker emoji', () => {
    const text = 'Đã sửa `src/a.ts`.\n\n```ts\nconst x = 1;\n```\n\n🔊 Xong rồi, test pass hết.\n';
    expect(pickSpeech(text)).toBe('Xong rồi, test pass hết.');
  });
  it('reads everything from the marker to the end, flattening lists', () => {
    const text = 'Bảng chi tiết ở trên.\n\n🔊 Có ba nhóm quyền:\n- Orders, **Agent** full\n- Products, Agent-only\n\nĐã xong.';
    expect(pickSpeech(text)).toBe('Có ba nhóm quyền: Orders, Agent full Products, Agent-only Đã xong.');
  });
  it('falls back to prose without code or markdown, cut at a sentence', () => {
    const long = 'Đã sửa xong. '.repeat(40);
    const text = `## Kết quả\n\n- **Sửa** hàm \`a\`\n\n\`\`\`\ncode\n\`\`\`\n\n${long}`;
    const out = pickSpeech(text);
    expect(out.startsWith('Kết quả Sửa hàm')).toBe(true);
    expect(out).not.toContain('code');
    expect(out).not.toContain('`');
    expect(out.length).toBeLessThanOrEqual(320);
    expect(out.endsWith('.')).toBe(true);
  });
  it('stripMarkdown flattens tables, links and emphasis', () => {
    expect(stripMarkdown('| a | b |\n|---|---|\nxem [tài liệu](http://x) *ngay* __đi__')).toBe('xem tài liệu ngay đi');
  });
});

describe('applyHooks', () => {
  const opts = { enabled: true, script: 'C:\\ext\\trongld.noidle-1.2.0\\dist\\claude-hook.js', voice: 'vi-VN-HoaiMyNeural', rate: '+0%', player: 'ffplay', notify: true };

  it('adds Stop and UserPromptSubmit hooks and keeps existing hooks', () => {
    const settings = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }] } };
    const out = applyHooks(settings, opts);
    expect(out.model).toBe('x');
    expect(out.hooks!.Stop).toHaveLength(2);
    expect(out.hooks!.Stop[0].hooks![0].command).toBe('node other.js');
    expect(out.hooks!.Stop[1].hooks![0].command).toBe(hookCommands(opts).Stop);
    expect(out.hooks!.UserPromptSubmit[0].hooks![0].command).toBe(hookCommands(opts).UserPromptSubmit);
    expect(hookCommands(opts).Stop).toContain('"C:/ext/trongld.noidle-1.2.0/dist/claude-hook.js" speak --voice vi-VN-HoaiMyNeural');
  });

  it('registers notify hooks with matchers when notify is on, none when off', () => {
    const on = applyHooks({}, opts);
    expect(on.hooks!.Notification[0].matcher).toBe('elicitation_dialog');
    expect(on.hooks!.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(on.hooks!.PermissionRequest[0].hooks![0].command).toContain(' notify ');
    expect(on.hooks!.PermissionRequest[0].hooks![0].timeout).toBe(120);
    expect(on.hooks!.PreToolUse[0].hooks![0].timeout).toBe(180);
    expect(on.hooks!.Stop[0].hooks![0].timeout).toBe(60); // Stop không còn chờ mic
    const withCfg = hookCommands({ ...opts, config: 'C:\\cfg\\hook-config.json' });
    expect(withCfg.Notify).toContain('--config "C:/cfg/hook-config.json"');
    expect(withCfg.Stop).toContain('--config "C:/cfg/hook-config.json"');
    const off = applyHooks({}, { ...opts, notify: false });
    expect(off.hooks!.Notification).toBeUndefined();
    expect(off.hooks!.PreToolUse).toBeUndefined();
    expect(off.hooks!.Stop).toHaveLength(1);
  });

  it('replaces an older NoIdle hook instead of duplicating it', () => {
    const once = applyHooks({}, { ...opts, script: 'C:/old/trongld.noidle-1.1.0/dist/claude-hook.js' });
    const twice = applyHooks(once, opts);
    expect(twice.hooks!.Stop).toHaveLength(1);
    expect(twice.hooks!.Stop[0].hooks![0].command).toContain('1.2.0');
  });

  it('removes NoIdle hooks when disabled and drops empty hook maps', () => {
    const on = applyHooks({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node keep.js' }] }] } }, opts);
    const off = applyHooks(on, { ...opts, enabled: false });
    expect(off.hooks).toEqual({ PostToolUse: [{ hooks: [{ type: 'command', command: 'node keep.js' }] }] });
    expect(applyHooks(applyHooks({}, opts), { ...opts, enabled: false })).toEqual({});
  });
});

describe('splitSentences', () => {
  it('keeps a first sentence of reasonable length alone, then groups two sentences per chunk within the char limit', () => {
    const text = 'Một câu mở đầu vừa đủ dài để nghe được vài giây. Hai. Ba. Bốn dài ' + 'x'.repeat(230) + '. Năm.';
    expect(splitSentences(text)).toEqual([
      'Một câu mở đầu vừa đủ dài để nghe được vài giây.',
      'Hai. Ba.',
      'Bốn dài ' + 'x'.repeat(230) + '.',
      'Năm.',
    ]);
  });
  it('merges a very short first sentence with the following ones so the first chunk covers a few seconds of audio', () => {
    const text = 'Xong hai việc. Một là hook giờ chỉ chèn hướng dẫn đầy đủ ở prompt đầu phiên, các prompt sau chèn một dòng nhắc. Hai là trang chi phí đã cập nhật.';
    const chunks = splitSentences(text);
    expect(chunks[0]).toBe('Xong hai việc. Một là hook giờ chỉ chèn hướng dẫn đầy đủ ở prompt đầu phiên,');
    expect(chunks.join(' ')).toBe(text);
    // Câu sau quá dài để gộp thì cụm đầu vẫn chỉ gồm các câu ngắn.
    expect(splitSentences('Một. Hai. Ba. Bốn dài ' + 'x'.repeat(230) + '.')[0]).toBe('Một. Hai. Ba.');
  });
  it('cuts a long first sentence at a comma so the first chunk is short', () => {
    const text = 'App có mười một trang chính trên thanh menu, gồm Orders, Rates, Exceptions, Customers, Accounts, Products, Contacts, Invoices, Billings, Users và Settings. Xong.';
    const chunks = splitSentences(text);
    expect(chunks[0].length).toBeLessThanOrEqual(90);
    expect(chunks[0].endsWith(',')).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });
  it('returns a single chunk for short text', () => {
    expect(splitSentences('  Xong rồi,  test pass. ')).toEqual(['Xong rồi, test pass.']);
  });
});

describe('announcement', () => {
  it('names the workspace from cwd', () => {
    expect(workspaceName('D:\\Project\\vi-voice')).toBe('vi voice');
    expect(workspaceName('/home/u/SHIPNGO-BE/')).toBe('SHIPNGO BE');
    expect(workspaceName('')).toBe('không tên');
  });
  it('keeps announcements simple: workspace plus what is needed', () => {
    expect(announcement({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: 'D:\\abc' })).toBe('Workspace abc cần approve.');
    expect(announcement({ hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: '/x/abc' })).toBe('Workspace abc cần approve.');
    expect(announcement({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: '/x/123', tool_input: { questions: [{ question: 'Dùng thư viện nào?' }] } }))
      .toBe('Workspace 123 cần bạn xác nhận câu trả lời.');
    expect(announcement({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', cwd: '/x/123' })).toBe('Workspace 123 cần bạn xác nhận câu trả lời.');
  });
  it('does not announce the permission step of AskUserQuestion twice', () => {
    expect(announcement({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', cwd: '/x/abc' })).toBe('');
  });
  it('ignores other events', () => {
    expect(announcement({ hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: '/x/abc' })).toBe('');
    expect(announcement({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/x/abc' })).toBe('');
  });
});

describe('lastAssistantText với transcript của Copilot', () => {
  it('lấy content của dòng assistant.message cuối cùng', () => {
    const jsonl = [
      line({ type: 'session.start', data: { sessionId: 's' } }),
      line({ type: 'user.message', data: { content: 'hỏi' } }),
      line({ type: 'assistant.message', data: { content: 'Để tôi xem.', toolRequests: [{ name: 'read_file' }] } }),
      line({ type: 'tool.execution_complete', data: { success: true } }),
      line({ type: 'assistant.message', data: { content: 'Xong.\n🔊 Đã xong rồi.' } }),
      line({ type: 'assistant.turn_end', data: { turnId: '1' } }),
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('Xong.\n🔊 Đã xong rồi.');
  });
  it('bỏ qua assistant.message rỗng', () => {
    const jsonl = [
      line({ type: 'assistant.message', data: { content: 'Có chữ.' } }),
      line({ type: 'assistant.message', data: { content: '', toolRequests: [{ name: 'x' }] } }),
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('Có chữ.');
  });
});

describe('doneAnnouncement (voiceStyle announce)', () => {
  it('says the workspace is done when the answer is a statement', () => {
    expect(doneAnnouncement('Đã sửa xong hàm A.\n\nTest pass hết.', 'D:\\Project\\vi-voice')).toBe('Workspace vi voice xong.');
  });
  it('says the workspace is asking when the answer ends with a question', () => {
    expect(doneAnnouncement('Có hai cách.\n\nBạn muốn dùng cách nào?', '/x/abc')).toBe('Workspace abc đang hỏi bạn.');
    expect(doneAnnouncement('Bạn chọn **cách 1** hay cách 2?  \n', '/x/abc')).toBe('Workspace abc đang hỏi bạn.');
  });
  it('ignores a trailing code block when deciding statement or question', () => {
    expect(doneAnnouncement('Chạy lệnh này nhé?\n```sh\nnpm test\n```', '/x/abc')).toBe('Workspace abc đang hỏi bạn.');
  });
  it('speaks English when the session language is en', () => {
    expect(doneAnnouncement('Done.', '/x/abc', 'en')).toBe('Workspace abc is done.');
    expect(doneAnnouncement('Which one?', '/x/abc', 'en')).toBe('Workspace abc is asking you.');
  });
});
