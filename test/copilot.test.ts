import { describe, it, expect } from 'vitest';
import { normalizeCopilotInput } from '../src/copilot';
import type { AgentHookInput, VoiceQuestion } from '../src/copilot';
import type { HookInput } from '../src/speech';
import { isDangerous, voiceApprovable } from '../src/decision';

const cli = (data: Record<string, unknown> = {}, event = 'PreToolUse') =>
  normalizeCopilotInput({ sessionId: 'cli-session', ...data }, event);
const ask = (toolArgs: unknown) => cli({ toolName: 'ask_user', toolArgs }).input;
const form = (properties: unknown, extra: Record<string, unknown> = {}) =>
  ask({ message: 'Configure deployment', requestedSchema: { type: 'object', properties, ...extra } });

describe('normalizeCopilotInput source and lifecycle', () => {
  it('normalizes CLI lifecycle fields without mutating the original record', () => {
    const raw = Object.freeze({
      sessionId: 'cli-session', transcriptPath: 'D:\\sessions\\events.jsonl', cwd: 'D:\\repo',
      hookName: 'sessionStart', stop_hook_active: false, prompt: 'continue', initialPrompt: 'start',
      agentId: 'agent-1', agentType: 'explore',
    });
    const { source, input } = normalizeCopilotInput(raw, 'SessionStart');
    expect(source).toBe('copilot-cli');
    expect(input).toMatchObject({
      session_id: 'cli-session', transcript_path: raw.transcriptPath, cwd: 'D:\\repo',
      hook_event_name: 'SessionStart', stop_hook_active: false, prompt: 'continue',
      initial_prompt: 'start', agent_id: 'agent-1', agent_type: 'explore',
    });
    expect(raw).not.toHaveProperty('session_id');
    const compatible: HookInput = input;
    expect(compatible.cwd).toBe('D:\\repo');
  });

  it('preserves Chat snake_case fields and native Claude-style questions unchanged', () => {
    const raw = Object.freeze({
      session_id: 'chat', transcript_path: 'D:\\chat\\events.jsonl', cwd: 'D:\\repo',
      hook_event_name: 'PreToolUse', stop_hook_active: true, prompt: 'go',
      agent_id: 'agent', agent_type: 'chat', initial_prompt: 'hi',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }] }] },
      other: { untouched: true },
    });
    expect(normalizeCopilotInput(raw, 'PreToolUse')).toEqual({ source: 'copilot', input: raw });
  });

  it('uses payload identity, not transcript filenames or producer hints', () => {
    expect(cli({ transcriptPath: 'D:\\chat\\events.jsonl', producer: 'vscode' }, 'Stop').source).toBe('copilot-cli');
    expect(normalizeCopilotInput({ session_id: 'chat', producer: 'copilot-cli' }, 'Stop').source).toBe('copilot');
  });

  it.each([
    null, undefined, [], 'json', 12, true, {}, { sessionId: '' }, { sessionId: '  ' },
    { sessionId: 12 }, { session_id: 12 }, { sessionId: 'cli', session_id: 'chat' },
    { sessionId: 'cli', session_id: undefined }, { session_id: 'chat', sessionId: null },
    Object.create({ sessionId: 'inherited' }),
  ])('rejects missing, mixed or malformed session envelopes: %j', (raw) => {
    expect(() => normalizeCopilotInput(raw, 'Stop')).toThrow(Error);
  });

  it.each([
    { transcriptPath: 7 }, { cwd: [] }, { prompt: null }, { initialPrompt: false },
    { agentId: {} }, { agentType: 1 }, { stop_hook_active: 'false' },
    { notificationType: 1 }, { message: {} }, { toolName: [] },
  ])('rejects malformed known CLI fields: %j', (fields) => {
    expect(() => cli(fields, 'Stop')).toThrow(Error);
  });

  it.each([{ transcript_path: [] }, { stop_hook_active: 'false' }, { tool_input: [] }, { tool_name: {} }])(
    'rejects malformed known Chat fields: %j', (fields) => {
      expect(() => normalizeCopilotInput({ session_id: 'chat', ...fields }, 'Stop')).toThrow(Error);
    },
  );

  it.each([
    ['sessionStart', 'SessionStart'], ['userPromptSubmitted', 'UserPromptSubmit'], ['agentStop', 'Stop'],
    ['permissionRequest', 'PermissionRequest'], ['preToolUse', 'PreToolUse'], ['notification', 'Notification'],
  ])('maps hookName %s when an explicit event is unavailable', (hookName, event) => {
    expect(cli({ hookName }, '').input.hook_event_name).toBe(event);
    expect(cli({}, hookName).input.hook_event_name).toBe(event);
  });

  it('prefers the trusted event argument over hookName', () => {
    expect(cli({ hookName: 'agentStop' }, 'PermissionRequest').input.hook_event_name).toBe('PermissionRequest');
  });

  it('does not invent an event for unknown aliases', () => {
    expect(() => cli({ hookName: 'userPromptTransformed' }, '')).toThrow(/event/i);
  });

  it('preserves CLI and Chat notification text, title and type', () => {
    expect(cli({ notificationType: 'elicitation_dialog', message: 'Please answer', title: 'Server' }, 'Notification').input)
      .toMatchObject({ notification_type: 'elicitation_dialog', message: 'Please answer', title: 'Server' });
    const raw = { session_id: 'chat', notification_type: 'elicitation_dialog', message: 'Please answer' };
    expect(normalizeCopilotInput(raw, 'Notification').input).toMatchObject(raw);
  });
});

describe('normalizeCopilotInput tool safety', () => {
  it.each([
    ['powershell', 'Bash'], ['bash', 'Bash'], ['view', 'Read'], ['edit', 'Edit'],
    ['apply_patch', 'Edit'], ['str_replace_editor', 'Edit'], ['create', 'Write'],
    ['grep', 'Grep'], ['rg', 'Grep'], ['glob', 'Glob'], ['ask_user', 'AskUserQuestion'],
    ['web_fetch', 'WebFetch'], ['update_todo', 'TodoWrite'], ['task', 'Agent'],
  ])('maps only the known native tool %s to %s', (toolName, expected) => {
    expect(cli({ toolName, toolArgs: {} }).input.tool_name).toBe(expected);
  });

  it.each(['mcp__server__view', 'server/view', 'custom_tool', 'View', 'constructor', '__proto__', 'toString'])(
    'leaves unknown tools unknown: %s', (toolName) => {
      const input = cli({ toolName, toolArgs: { path: 'D:\\repo\\safe.ts' } }).input;
      expect(input.tool_name).toBe(toolName);
      expect(input.tool_input).not.toHaveProperty('file_path');
      expect(voiceApprovable(input.tool_name, input.tool_input)).toBe(false);
    },
  );

  it.each(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'AskUserQuestion', 'WebFetch', 'TodoWrite', 'Agent', 'LS', 'WebSearch', 'Task', 'MultiEdit', 'NotebookEdit'])(
    'rejects an unknown CLI tool colliding with trusted Claude identity: %s', (toolName) => {
      expect(() => cli({ toolName, toolArgs: { path: 'safe.ts', file_path: 'safe.ts', command: 'git status' } }))
        .toThrow(/unsupported.*tool/i);
    },
  );

  it.each(['toolInput', 'toolArgs'])('parses a JSON object in %s without stripping security flags', (field) => {
    const input = cli({
      toolName: 'powershell', [field]: '{"command":"git status","requestSandboxBypass":true,"justification":"needs network"}',
      requestSandboxBypass: true,
    }, field === 'toolInput' ? 'PermissionRequest' : 'PreToolUse').input;
    expect(input).toMatchObject({
      tool_name: 'Bash', requestSandboxBypass: true,
      tool_input: { command: 'git status', requestSandboxBypass: true, justification: 'needs network' },
    });
  });

  it.each(['toolInput', 'toolArgs'])('rejects malformed or non-object %s even for nominally safe tools', (field) => {
    for (const value of [null, undefined, [], 1, true, '', '{broken', 'null', '[]', '"text"', '3', 'false']) {
      expect(() => cli({ toolName: 'view', [field]: value }, 'PermissionRequest')).toThrow(Error);
    }
  });

  it('does not silently approve a tool whose arguments are missing', () => {
    expect(() => cli({ toolName: 'view' }, 'PermissionRequest')).toThrow(/tool(Input|Args)|arguments/i);
  });

  it('rejects ambiguous dual argument sources rather than choosing the safer-looking one', () => {
    expect(() => cli({ toolName: 'edit', toolInput: { file_path: 'safe.ts' }, toolArgs: { path: '.env' } })).toThrow(Error);
  });

  it.each(['view', 'edit', 'apply_patch', 'str_replace_editor', 'create'])('normalizes path for %s without mutation', (toolName) => {
    const args = Object.freeze({ path: 'D:\\repo\\.env', diff: '+TOKEN=value', requestSandboxBypass: true });
    const input = cli({ toolName, toolInput: args }, 'PermissionRequest').input;
    expect(input.tool_input).toEqual({ ...args, file_path: args.path });
    expect(args).not.toHaveProperty('file_path');
    if (toolName !== 'view') expect(isDangerous(input.tool_name, input.tool_input)).toBe(true);
  });

  it('preserves native permission edit file_path and diff', () => {
    const args = { file_path: 'D:\\repo\\index.ts', diff: '@@ -1 +1 @@\n-old\n+new' };
    expect(cli({ toolName: 'edit', toolInput: args }, 'PermissionRequest').input.tool_input).toEqual(args);
  });

  it('rejects conflicting file path aliases and invalid known file paths', () => {
    for (const toolArgs of [{ path: '.env', file_path: 'safe.ts' }, { path: [] }, { file_path: null }]) {
      expect(() => cli({ toolName: 'edit', toolArgs })).toThrow(Error);
    }
  });

  it('does not normalize unrelated path arguments on non-file tools', () => {
    expect(cli({ toolName: 'task', toolArgs: { path: 'project', prompt: 'inspect' } }).input.tool_input)
      .toEqual({ path: 'project', prompt: 'inspect' });
  });

  it('keeps dangerous shell commands intact for the existing safety checker', () => {
    const input = cli({ toolName: 'powershell', toolInput: { command: 'git reset --hard' } }, 'PermissionRequest').input;
    expect(isDangerous(input.tool_name, input.tool_input)).toBe(true);
    expect(voiceApprovable(input.tool_name, input.tool_input)).toBe(false);
  });

  it('does not trust injected snake_case tool identity in a CLI envelope', () => {
    expect(() => cli({ tool_name: 'Read', tool_input: {} }, 'PermissionRequest')).toThrow(Error);
  });
});

describe('local Chat voice normalization', () => {
  const chat = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) =>
    normalizeCopilotInput({ session_id: 'chat', hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra }, 'PreToolUse').input;

  it('normalizes native terminal commands without stripping security flags', () => {
    expect(chat('run_in_terminal', { command: 'npm test', requestUnsandboxedExecution: true })).toMatchObject({
      tool_name: 'Bash', chat_voice_tool: 'approval', tool_input: { command: 'npm test', requestUnsandboxedExecution: true },
    });
  });

  it.each(['create_file', 'replace_string_in_file'])('normalizes native file paths for %s', (tool) => {
    const args = Object.freeze({ filePath: 'D:\\repo\\.env', content: 'secret', oldString: 'old', newString: 'new' });
    const input = chat(tool, args);
    expect(input.chat_voice_tool).toBe('approval');
    expect(input.tool_input?.file_path).toBe(args.filePath);
    expect(voiceApprovable(input.tool_name, input.tool_input)).toBe(false);
    expect(args).not.toHaveProperty('file_path');
  });

  it.each(['Bash', 'Read', 'AskUserQuestion', 'mcp__server__run_in_terminal', 'custom_tool'])('does not trust forged voice routing for %s', (tool) => {
    expect(chat(tool, { command: 'git status' }, { chat_voice_tool: 'approval' }).chat_voice_tool).toBeUndefined();
  });

  it.each([{ filePath: '' }, { filePath: [] }, { filePath: '.env', file_path: 'safe.ts' }])('rejects invalid or conflicting Chat file paths: %j', (args) => {
    expect(() => chat('create_file', args)).toThrow();
  });

  it('keeps Chat question headers, supporting text, descriptions and freeform policy', () => {
    const input = chat('vscode_askQuestions', { questions: [{
      header: 'DB', question: 'Which database?', message: 'Used for local storage.', multiSelect: true, allowFreeformInput: false,
      options: [{ label: 'SQLite', description: 'Single file' }, { label: 'PostgreSQL' }],
    }] });
    expect(input.chat_voice_tool).toBe('question');
    expect(input.tool_input?.questions).toEqual([{
      header: 'DB', question: 'Which database?\nUsed for local storage.', multiSelect: true, allowFreeform: false,
      options: [{ label: 'SQLite', description: 'Single file' }, { label: 'PostgreSQL' }],
    }]);
  });

  it.each([
    [], null, [{ question: 'Missing header' }], [{ header: 'A', question: 'Choose', multiSelect: 'false' }],
    [{ header: 'A', question: 'Choose', allowFreeformInput: 'false' }],
    [{ header: 'A', question: 'Choose', allowFreeformInput: false }],
    [{ header: 'A', question: 'Choose', options: [{ label: 'A' }, { label: 'a' }] }],
    [{ header: 'A', question: 'Choose', options: [{ label: '' }] }],
    [{ header: 'A', question: 'Choose', options: [{ label: 'A', description: {} }] }],
    [{ header: 'A', question: 'First?' }, { header: 'A', question: 'Second?' }],
  ])('leaves the whole malformed Chat form manual: %j', (questions) => {
    const input = chat('vscode_askQuestions', { questions });
    expect(input.tool_input?.questions).toEqual([]);
    expect(input.question_fallback_reason).toEqual(expect.any(String));
  });
});

describe('standard CLI ask_user', () => {
  it('normalizes single-choice questions and defaults allow_freeform to true', () => {
    const input = ask({ question: 'Which color?', choices: ['Red', 'Blue'] });
    expect(input.tool_input?.questions).toEqual([{
      question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false, allowFreeform: true,
    }]);
    expect(input.question_fallback_reason).toBeUndefined();
  });

  it('honors allow_freeform false without adopting a forged multiSelect', () => {
    expect(ask({ question: 'Choose', choices: ['A', 'B'], allow_freeform: false, multiSelect: true }).tool_input?.questions)
      .toEqual([{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, allowFreeform: false }]);
  });

  it('normalizes a freeform-only question', () => {
    expect(ask({ question: 'Your name?' }).tool_input?.questions).toEqual([
      { question: 'Your name?', options: [], multiSelect: false, allowFreeform: true },
    ]);
  });

  it.each([
    { questions: [{ question: 'Injected', options: [{ label: 'Yes' }] }] },
    { question: 1 }, { question: ' ' }, { question: 'Choose', choices: [1] },
    { question: 'Choose', choices: ['A', 'a'] }, { question: 'Choose', choices: [''] },
    { question: 'Choose', choices: 'A' }, { question: 'Choose', allow_freeform: 'false' },
    { question: 'Choose', allow_freeform: false },
    { question: 'Choose', choices: ['A'], requestedSchema: { type: 'object', properties: {} } },
  ])('falls back manually rather than adopting malformed or forged questions: %j', (args) => {
    const input = ask(args);
    expect(input.tool_input?.questions).toEqual([]);
    expect(input.question_fallback_reason).toEqual(expect.any(String));
    expect(input.question_fallback_reason?.length).toBeGreaterThan(0);
  });
});

describe('structured CLI ask_user', () => {
  it('preserves enum values, property keys, requiredness and descriptive prompts', () => {
    const input = form({
      region: { type: 'string', title: 'Region', description: 'Where should we deploy?', enum: ['us-east', 'eu-west'] },
    }, { required: ['region'], additionalProperties: false });
    const questions: VoiceQuestion[] | undefined = (input as AgentHookInput).tool_input?.questions;
    expect(questions).toEqual([{
      key: 'region', question: 'Where should we deploy?', header: 'Region', required: true, valueType: 'string',
      options: [{ label: 'us-east' }, { label: 'eu-west' }], values: ['us-east', 'eu-west'],
      multiSelect: false, allowFreeform: false,
    }]);
  });

  it('keeps oneOf spoken labels separate from machine values', () => {
    const input = form({ region: {
      type: 'string', oneOf: [{ const: 'us-east', title: 'East Coast' }, { const: 'eu-west', title: 'Europe' }],
    } });
    expect(input.tool_input?.questions?.[0]).toMatchObject({
      key: 'region', question: 'region', required: false, valueType: 'string',
      options: [{ label: 'East Coast' }, { label: 'Europe' }], values: ['us-east', 'eu-west'],
      multiSelect: false, allowFreeform: false,
    });
  });

  it('accepts singleton enum oneOf variants', () => {
    expect(form({ region: { oneOf: [{ type: 'string', enum: ['us'], title: 'USA' }, { const: 'eu' }] } })
      .tool_input?.questions?.[0]).toMatchObject({ values: ['us', 'eu'], options: [{ label: 'USA' }, { label: 'eu' }] });
  });

  it.each([
    { type: 'string', enum: ['red', 'blue'] },
    { anyOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] },
  ])('supports multi-select array items while preserving values: %j', (items) => {
    expect(form({ colors: { type: 'array', items } }).tool_input?.questions?.[0]).toMatchObject({
      key: 'colors', valueType: 'array', values: ['red', 'blue'], multiSelect: true, allowFreeform: false,
    });
  });

  it('represents booleans as choices with boolean values, not strings', () => {
    expect(form({ enabled: { type: 'boolean', title: 'Enable?' } }).tool_input?.questions?.[0]).toMatchObject({
      key: 'enabled', question: 'Enable?', options: [{ label: 'Yes' }, { label: 'No' }],
      values: [true, false], valueType: 'boolean', multiSelect: false, allowFreeform: false,
    });
  });

  it.each(['string', 'number', 'integer'])('exposes the scalar type for freeform %s answers', (type) => {
    expect(form({ answer: { type } }).tool_input?.questions?.[0]).toMatchObject({
      key: 'answer', valueType: type, options: [], allowFreeform: true, multiSelect: false,
    });
  });

  it.each([
    { type: 'string', minLength: 2 }, { type: 'string', pattern: '^a' }, { type: 'string', format: 'email' },
    { type: 'number', minimum: 1 }, { type: 'integer', multipleOf: 2 },
    { type: 'object', properties: { nested: { type: 'string' } } }, { type: ['string', 'null'] },
    { $ref: '#/$defs/choice' }, { type: 'array', items: { type: 'string' } },
    { type: 'array', items: { enum: ['a'] }, minItems: 1 },
    { type: 'array', items: { enum: ['a'] }, maxItems: 1 },
    { type: 'array', items: { enum: ['a'] }, uniqueItems: true },
    { type: 'number', enum: [1, 2] }, { enum: [] }, { enum: ['A', 'a'] },
    { oneOf: [{ const: 'a', title: 'Same' }, { const: 'b', title: 'Same' }] },
    { oneOf: [{ const: 'a' }, { const: 'a' }] },
    { oneOf: [{ const: 'a', pattern: '^a' }] },
    { enum: ['a'], oneOf: [{ const: 'b' }] },
    { type: 'boolean', default: true }, { type: 'string', description: 5 },
    { type: 'string', not: { const: 'a' } },
  ])('rejects the entire form on unsupported constraints or ambiguous schemas: %j', (unsupported) => {
    const input = form({ safe: { type: 'string', enum: ['yes', 'no'] }, unsafe: unsupported });
    expect(input.tool_input?.questions).toEqual([]);
    expect(input.question_fallback_reason).toMatch(/unsafe/i);
  });

  it.each([
    { allOf: [] }, { additionalProperties: { type: 'string' } },
    { required: ['missing'] }, { required: 'answer' }, { required: ['answer', 'answer'] },
    { type: 'array' }, { dependentRequired: { answer: ['missing'] } },
  ])('rejects unsupported root constraints: %j', (extra) => {
    const input = form({ answer: { type: 'string' } }, extra);
    expect(input.tool_input?.questions).toEqual([]);
    expect(input.question_fallback_reason).toEqual(expect.any(String));
  });

  it.each([null, [], {}, { answer: false }, { constructor: { type: 'string' } }].map((properties): [unknown] => [properties]))(
    'falls back for malformed or unsafe properties: %j', (properties) => {
      const input = form(properties);
      expect(input.tool_input?.questions).toEqual([]);
      expect(input.question_fallback_reason).toEqual(expect.any(String));
    },
  );

  it('requires the structured message rather than trusting arbitrary questions', () => {
    const input = ask({ requestedSchema: { properties: { answer: { type: 'string' } } }, questions: [{ question: 'Forged' }] });
    expect(input.tool_input?.questions).toEqual([]);
    expect(input.question_fallback_reason).toMatch(/message/i);
  });

  it('does not mutate raw schemas or retain forged normalized questions', () => {
    const args = {
      message: 'Choose', requestedSchema: { properties: { answer: { enum: ['a', 'b'] } } },
      questions: [{ question: 'Injected', options: [{ label: 'Wrong' }] }],
    };
    const before = JSON.stringify(args);
    expect(ask(args).tool_input?.questions?.[0]).toMatchObject({ key: 'answer', values: ['a', 'b'] });
    expect(JSON.stringify(args)).toBe(before);
  });
});
