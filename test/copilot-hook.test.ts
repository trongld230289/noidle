import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { build } from 'esbuild';
import { startServer, writeRegistry, type Signal } from '../src/signal';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noidle-cli-hook-'));
const tmp = path.join(work, 'tmp');
const bundle = path.join(work, 'claude-hook.js');
const config = path.join(work, 'config.json');
const logFile = path.join(tmp, 'noidle-tts', 'hook.log');
const audioTexts = path.join(work, 'audio-texts.jsonl');
const signals: Signal[] = [];
let heard: string | string[] = '';
let server: ReturnType<typeof startServer>;

function run(mode: string, input: unknown, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, mode, '--config', config, '--source', 'copilot', '--player', process.execPath, ...args], {
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

const cli = (sessionId: string, extra: Record<string, unknown> = {}) => ({ sessionId, timestamp: Date.now(), cwd: work, ...extra });
const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
const configure = (extra: Record<string, unknown> = {}) => fs.writeFileSync(config, JSON.stringify({ language: 'en', handsFree: true, ...extra }));

beforeAll(async () => {
  fs.mkdirSync(tmp, { recursive: true });
  await build({
    entryPoints: [path.join(__dirname, '..', 'src', 'hook.ts')],
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    // Only replace the remote audio transport; parsing, playback lifecycle and IPC remain real.
    plugins: [{
      name: 'offline-tts',
      setup(builder) {
        builder.onResolve({ filter: /^msedge-tts$/ }, () => ({ path: 'tts', namespace: 'offline' }));
        builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({
          contents: `
            const { Readable } = require('stream');
            const fs = require('fs');
            exports.OUTPUT_FORMAT = { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' };
            exports.MsEdgeTTS = class {
              async setMetadata() {}
              toStream(text) {
                fs.appendFileSync(${JSON.stringify(audioTexts)}, JSON.stringify(text) + '\\n');
                return { audioStream: Readable.from([Buffer.from('audio')]) };
              }
              close() {}
            };
          `,
        }));
      },
    }],
  });
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\noidle-cli-${process.pid}-${Date.now()}`
    : path.join(work, 'cli.sock');
  server = startServer(pipe, (signal) => {
    signals.push(signal);
    if (signal.event === 'ask') return typeof heard === 'string' ? heard : heard.shift() ?? '';
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  writeRegistry({ pid: process.pid, pipe, folders: [work] }, path.join(tmp, 'noidle-tts', 'windows'));
  configure();
  await run('skip', {});
}, 30_000);

beforeEach(() => {
  signals.length = 0;
  heard = '';
  fs.writeFileSync(audioTexts, '');
  configure();
});

async function playbackFinished() {
  await vi.waitFor(() => {
    const queue = path.join(tmp, 'noidle-tts', 'queue');
    for (const file of fs.existsSync(queue) ? fs.readdirSync(queue) : []) {
      const { pid } = JSON.parse(fs.readFileSync(path.join(queue, file), 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }
  }, { timeout: 10_000 });
}

afterEach(playbackFinished, 15_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await playbackFinished();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Copilot CLI instructions', () => {
  it('provides native startup context without replacing the user prompt', async () => {
    const result = await run('start', cli('cli-start', { source: 'new', initialPrompt: 'Explain the result' }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ additionalContext: expect.stringContaining('headphones') });
    expect(signals).toEqual([]);
  });

  it('keeps Chat startup silent and Chat prompt output unchanged', async () => {
    const input = { session_id: 'chat-start', hook_event_name: 'SessionStart', cwd: work };
    expect((await run('start', input)).stdout).toBe('');
    const result = await run('prompt', { ...input, hook_event_name: 'UserPromptSubmit', prompt: 'Continue' });
    expect(JSON.parse(result.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('headphones'),
    });
  });

  it('preserves the complete CLI prompt and stops its microphone', async () => {
    const prompt = 'Explain this code:\n```\nconst x = 1;\n```';
    const result = await run('prompt', cli('cli-prompt', { prompt }));
    expect(JSON.parse(result.stdout).modifiedPrompt).toContain(prompt);
    expect(JSON.parse(result.stdout).modifiedPrompt).toContain('headphones');
    expect(signals).toContainEqual(expect.objectContaining({ event: 'submitted', session: 'cli-prompt', source: 'copilot-cli' }));
  });

  it('does not inject instructions while muted, but still reports a submitted prompt', async () => {
    configure({ voiceMute: true });
    expect((await run('start', cli('cli-muted'))).stdout).toBe('');
    expect((await run('prompt', cli('cli-muted', { prompt: 'Continue' }))).stdout).toBe('');
    expect(signals.some((s) => s.event === 'submitted' && s.session === 'cli-muted')).toBe(true);
  });

  it('keeps announce startup free of recap instructions', async () => {
    configure({ voiceStyle: 'announce' });
    expect((await run('start', cli('cli-announce'))).stdout).toBe('');
  });

  it('updates CLI recap instructions when language or voice style changes', async () => {
    configure({ language: 'auto' });
    const input = cli('cli-settings', { prompt: 'Please explain the API' });
    expect(JSON.parse((await run('prompt', input)).stdout).modifiedPrompt).toContain('in English');
    const vietnamese = cli('cli-settings', { prompt: 'Giải thích bằng tiếng Việt nhé' });
    expect(JSON.parse((await run('prompt', vietnamese)).stdout).modifiedPrompt).toContain('Viết bằng tiếng Việt');
    configure({ voiceStyle: 'announce' });
    expect(JSON.parse((await run('prompt', input)).stdout).modifiedPrompt).toContain('no longer needed');
    expect((await run('prompt', input)).stdout).toBe('');
  });

  it('rejects ambiguous client payloads without any IPC', async () => {
    const before = log().length;
    const result = await run('prompt', { ...cli('cli-ambiguous'), session_id: 'chat-ambiguous', prompt: 'Continue' });
    expect(result.stdout).toBe('');
    expect(signals).toEqual([]);
    expect(log().slice(before)).toMatch(/invalid|ambiguous|mixed/i);
  });
});

describe('Copilot CLI speech and terminal routing', () => {
  it('normalizes the CLI transcript path and carries CLI ancestry through detached playback', async () => {
    const transcriptPath = path.join(work, 'events.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant.message', data: { content: 'Finished.' } }) + '\n');
    const result = await run('speak', cli('cli-playback', { transcriptPath, stopReason: 'end_turn' }));
    expect(result.code).toBe(0);
    await vi.waitFor(() => {
      const listen = signals.find((s) => s.event === 'listen' && s.session === 'cli-playback');
      expect(listen?.source).toBe('copilot-cli');
      expect(listen?.ancestors).toContain(process.pid);
    }, { timeout: 15_000 });
    expect(signals.some((s) => s.event === 'attention' && s.session === 'cli-playback')).toBe(true);
  }, 20_000);

  it('keeps terminal ancestry after the per-hook shell has exited', async () => {
    const transcriptPath = path.join(work, 'ephemeral.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant.message', data: { content: 'Finished.' } }));
    await new Promise<void>((resolve, reject) => {
      const wrapper = spawn(process.execPath, ['-e', `
        const child = require('child_process').spawn(process.execPath, process.argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(${JSON.stringify(JSON.stringify(cli('cli-ephemeral', { transcriptPath })))});
        child.on('exit', () => process.exit(0));
      `, bundle, 'speak', '--source', 'copilot', '--config', config, '--player', process.execPath], {
        env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
        stdio: 'ignore',
      });
      wrapper.on('error', reject);
      wrapper.on('exit', () => resolve());
    });
    await vi.waitFor(() => {
      expect(signals.find((s) => s.event === 'listen' && s.session === 'cli-ephemeral')?.ancestors).toContain(process.pid);
    }, { timeout: 15_000 });
  }, 20_000);

  it('does not read or reopen the microphone when the CLI stop hook is already active', async () => {
    const before = log().length;
    await run('speak', cli('cli-blocked-stop', { transcriptPath: path.join(work, 'events.jsonl'), stop_hook_active: true }));
    expect(signals).toEqual([]);
    expect(log().slice(before)).not.toContain('play pid');
  });
});

describe('Copilot CLI voice permissions', () => {
  it.each([
    ['yes', { behavior: 'allow' }],
    ['no', { behavior: 'deny', message: expect.stringContaining('no') }],
  ])('returns a native permission decision for %s', async (answer, output) => {
    heard = answer;
    const result = await run('notify', cli(`cli-permission-${answer}`, { toolName: 'powershell', toolInput: { command: 'git status' } }), ['--event', 'PermissionRequest']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(output);
    expect(signals.some((s) => s.event === 'ask' && s.source === 'copilot-cli')).toBe(true);
  }, 20_000);

  it.each([
    { toolName: 'powershell', toolInput: { command: 'git push origin main' } },
    { toolName: 'edit', toolInput: { file_path: '.env.production' } },
    { toolName: 'unknown_mcp', toolInput: {} },
    { toolName: 'web_fetch', toolInput: { url: 'https://example.com', requestSandboxBypass: true } },
  ])('leaves unsafe or unknown permissions to manual approval: $toolName', async (tool) => {
    heard = 'yes';
    const result = await run('notify', cli('cli-unsafe', tool), ['--event', 'PermissionRequest']);
    expect(result.stdout).toBe('');
    expect(signals.some((s) => s.event === 'ask')).toBe(false);
  });

  it('falls through on unclear approval instead of emitting success', async () => {
    heard = 'maybe later';
    const result = await run('notify', cli('cli-unclear', { toolName: 'powershell', toolInput: { command: 'git status' } }), ['--event', 'PermissionRequest']);
    expect(result.stdout).toBe('');
    expect(signals.some((s) => s.event === 'ask')).toBe(true);
  }, 20_000);

  it('does not enable voice permission hooks for local Chat', async () => {
    await run('notify', { session_id: 'chat-permission', cwd: work, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git status' } }, ['--event', 'PermissionRequest']);
    expect(signals).toEqual([]);
  });

  it('keeps muted CLI permission requests manual while still drawing attention', async () => {
    configure({ voiceMute: true });
    heard = 'yes';
    const result = await run('notify', cli('cli-permission-muted', { toolName: 'powershell', toolInput: { command: 'git status' } }), ['--event', 'PermissionRequest']);
    expect(result.stdout).toBe('');
    expect(signals.some((s) => s.event === 'ask')).toBe(false);
    expect(signals.some((s) => s.event === 'attention' && s.reason === 'approve')).toBe(true);
  });
});

describe('Copilot Chat voice controls', () => {
  const chat = (tool_name: string, tool_input: unknown) => ({
    session_id: 'chat-voice', cwd: work, hook_event_name: 'PreToolUse', tool_name, tool_input,
  });
  const question = { header: 'Database', question: 'Which database?', allowFreeformInput: false, options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }] };

  it.each([
    ['yes', 'allow'],
    ['no', 'deny'],
  ])('returns a local pre-tool approval decision for %s', async (answer, decision) => {
    heard = answer;
    const result = await run('notify', {
      session_id: `chat-approval-${answer}`, cwd: work, hook_event_name: 'PreToolUse',
      tool_name: 'run_in_terminal', tool_input: { command: 'git status', explanation: 'Check changes' },
    }, ['--event', 'PreToolUse']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: decision,
        permissionDecisionReason: expect.stringContaining(answer),
      },
    });
    expect(signals.some((signal) => signal.event === 'ask' && signal.source === 'copilot' && signal.reason === 'approve')).toBe(true);
  }, 20_000);

  it('answers a local question through hook feedback', async () => {
    heard = 'two';
    const result = await run('notify', {
      session_id: 'chat-choice', cwd: work, hook_event_name: 'PreToolUse', tool_name: 'vscode_askQuestions',
      tool_input: { questions: [{ header: 'Database', question: 'Which database?', allowFreeformInput: false, options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }] }] },
    }, ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('SQLite'),
      },
    });
    expect(signals.some((signal) => signal.event === 'ask' && signal.source === 'copilot' && signal.reason === 'answer')).toBe(true);
  }, 20_000);

  it.each(['', 'maybe later'])('requires manual confirmation on unclear approval: %j', async (answer) => {
    heard = answer;
    const result = await run('notify', chat('run_in_terminal', { command: 'npm test' }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    expect(signals.some((signal) => signal.event === 'ask')).toBe(true);
  }, 20_000);

  it.each([
    ['run_in_terminal', { command: 'git push origin main' }],
    ['run_in_terminal', { command: 'rm -rf src' }],
    ['run_in_terminal', { command: 'git status', requestSandboxBypass: true }],
    ['run_in_terminal', { command: 'git status', requestUnsandboxedExecution: true }],
    ['run_in_terminal', { command: 'git status', requestAllowNetwork: true }],
    ['create_file', { filePath: 'D:\\repo\\.env', content: 'secret' }],
  ])('requires manual approval without opening the mic: %s %j', async (tool, args) => {
    heard = 'yes';
    const result = await run('notify', chat(tool, args), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    expect(signals.some((signal) => signal.event === 'ask')).toBe(false);
  });

  it.each(['create_file', 'replace_string_in_file'])('allows a known ordinary file operation only after confirmation: %s', async (tool) => {
    heard = 'yes';
    const result = await run('notify', chat(tool, { filePath: 'D:\\repo\\src\\example.ts', content: 'text', oldString: 'old', newString: 'new' }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(signals.some((signal) => signal.event === 'ask')).toBe(true);
  }, 20_000);

  // Câu báo giữ tên workspace (nhiều cửa sổ thì biết cửa sổ nào xin) và lý do, nhưng lệnh chỉ đọc vài từ đầu.
  it.each([
    // Tiếng Việt: bảng cách đọc đổi "Workspace", tên tool và lệnh sang phiên âm, nên chỉ so phần lý do ở cuối.
    ['vi', 'rm -rf src', /Lệnh này thuộc loại nguy hiểm, bạn bấm tay nhé\.$/],
    ['en', 'rm -rf src', /^Workspace .+ needs approval\. Bash: rm -rf src\. This command is in the dangerous category, please confirm by hand\.$/],
    ['vi', `node script.js ${'private-argument '.repeat(40)}`, /Lệnh này chưa nằm trong danh sách an toàn, bạn bấm tay nhé\.$/],
    ['en', `node script.js ${'private-argument '.repeat(40)}`, /^Workspace .+ needs approval\. Bash: node script\.js private-argument\. This command is not on the safe list, please confirm by hand\.$/],
  ])('keeps manual approval speech brief without reading the whole command: %s %s', async (language, command, expected) => {
    configure({ language });
    fs.rmSync(path.join(tmp, 'noidle-tts', 'cache'), { recursive: true, force: true });
    heard = 'yes';
    const result = await run('notify', {
      ...chat('run_in_terminal', { command }), session_id: `brief-${language}-${command.startsWith('rm') ? 'dangerous' : 'unknown'}`,
    }, ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    expect(signals.some((signal) => signal.event === 'ask')).toBe(false);
    await vi.waitFor(() => {
      const texts = fs.readFileSync(audioTexts, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      // Player giả ghi từng câu một dòng; ghép lại để so cả câu báo.
      const spoken = texts.join(' ');
      expect(spoken).toMatch(expected);
      expect(spoken.length).toBeLessThan(160);
      expect((spoken.match(/private/g) ?? []).length).toBeLessThanOrEqual(1);
    }, { timeout: 10_000 });
  }, 15_000);

  it.each(['Bash', 'Read', 'mcp__server__run_in_terminal', 'apply_patch', 'multi_replace_string_in_file'])('does not approve unknown or unvalidated tools: %s', async (tool) => {
    heard = 'yes';
    const result = await run('notify', { ...chat(tool, { command: 'git status', file_path: 'safe.ts' }), chat_voice_tool: 'approval' }, ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals).toEqual([]);
  });

  it.each([
    [{ handsFree: false }, 'run_in_terminal', { command: 'git status' }],
    [{ voiceMute: true }, 'run_in_terminal', { command: 'git status' }],
    [{ handsFree: false }, 'vscode_askQuestions', { questions: [question] }],
    [{ voiceMute: true }, 'vscode_askQuestions', { questions: [question] }],
  ])('respects disabled voice controls: %j', async (settings, tool, args) => {
    configure(settings);
    heard = 'yes';
    expect((await run('notify', chat(tool, args), ['--event', 'PreToolUse'])).stdout).toBe('');
    expect(signals.some((signal) => signal.event === 'ask')).toBe(false);
  });

  it.each([
    ['one and two', { multiSelect: true }, ['PostgreSQL', 'SQLite']],
    ['all', { multiSelect: true }, ['PostgreSQL', 'SQLite']],
    ['SQLite', {}, ['SQLite']],
    ['MariaDB', { allowFreeformInput: true }, ['MariaDB']],
    ['Use a local cache', { options: undefined, allowFreeformInput: true }, ['Use a local cache']],
  ])('passes a valid spoken question answer with its header: %s', async (answer, extra, expected) => {
    heard = answer;
    const result = await run('notify', chat('vscode_askQuestions', { questions: [{ ...question, ...extra }] }), ['--event', 'PreToolUse']);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toContain('Database');
    for (const label of expected) expect(output.permissionDecisionReason).toContain(label);
  }, 20_000);

  it.each(['', 'cancel', 'not sure', 'one and two'])('falls back to the question UI without a fabricated answer: %j', async (answer) => {
    heard = answer;
    expect((await run('notify', chat('vscode_askQuestions', { questions: [question] }), ['--event', 'PreToolUse'])).stdout).toBe('');
  }, 20_000);

  it('does not return partial answers when a later question is malformed', async () => {
    heard = 'one';
    const result = await run('notify', chat('vscode_askQuestions', { questions: [question, { question: 'Invalid' }] }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals.some((signal) => signal.event === 'ask')).toBe(false);
  });

  it.each(['do not delete', 'not sure', 'maybe later'])('leaves ambiguous Chat answers manual even with default freeform: %s', async (answer) => {
    heard = answer;
    const result = await run('notify', chat('vscode_askQuestions', { questions: [{
      header: 'Action', question: 'What next?', options: [{ label: 'Delete' }, { label: 'Keep' }],
    }] }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
  }, 20_000);

  it('accepts an exact negative label instead of guessing from a negative sentence', async () => {
    heard = 'No';
    const result = await run('notify', chat('vscode_askQuestions', { questions: [{
      header: 'Confirm', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }],
    }] }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toContain('No');
  }, 20_000);

  it('speaks question headers and option descriptions before listening', async () => {
    heard = ['one', 'two'];
    const result = await run('notify', chat('vscode_askQuestions', { questions: [
      { ...question, header: 'Production', options: [{ label: 'PostgreSQL', description: 'Managed database' }, { label: 'SQLite' }] },
      { ...question, header: 'Staging' },
    ] }), ['--event', 'PreToolUse']);
    const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('Production');
    expect(reason).toContain('Staging');
    const audio = fs.readFileSync(audioTexts, 'utf8');
    expect(audio).toContain('Production: Which database?');
    expect(audio).toContain('Staging: Which database?');
    expect(audio).toContain('Managed database');
  }, 20_000);

  it('does not return partial answers when the second valid question is cancelled', async () => {
    heard = ['one', 'cancel'];
    const result = await run('notify', chat('vscode_askQuestions', { questions: [question, { ...question, header: 'Replica' }] }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals.filter((signal) => signal.event === 'ask')).toHaveLength(2);
  }, 20_000);

  it('does not open the CLI approval mic from the shared pre-tool hook', async () => {
    heard = 'yes';
    const result = await run('notify', cli('cli-pre-tool', { toolName: 'powershell', toolArgs: { command: 'git status' } }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals).toEqual([]);
  });
});

describe('Copilot CLI voice questions', () => {
  const question = { question: 'Which database?', choices: ['PostgreSQL', 'SQLite'], allow_freeform: false };

  it('answers ask_user through native hook feedback without approving the tool', async () => {
    heard = 'two';
    const result = await run('notify', cli('cli-choice', { toolName: 'ask_user', toolArgs: JSON.stringify(question) }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout)).toEqual({
      permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('SQLite'),
    });
    expect(signals.some((s) => s.event === 'ask')).toBe(true);
  }, 20_000);

  it('does not submit multiple selections for a single-choice question', async () => {
    heard = 'one and two';
    const result = await run('notify', cli('cli-single', { toolName: 'ask_user', toolArgs: question }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals.some((s) => s.event === 'ask')).toBe(true);
  }, 20_000);

  it('supports a freeform answer when ask_user permits it', async () => {
    heard = 'MariaDB';
    const result = await run('notify', cli('cli-freeform', { toolName: 'ask_user', toolArgs: { ...question, allow_freeform: true } }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).permissionDecisionReason).toContain('MariaDB');
  }, 20_000);

  it('preserves structured property keys and enum values when selecting multiple labels', async () => {
    heard = 'one and two';
    const result = await run('notify', cli('cli-structured', {
      toolName: 'ask_user',
      toolArgs: {
        message: 'Choose formats',
        requestedSchema: {
          type: 'object',
          properties: {
            formats: {
              type: 'array', title: 'Output formats',
              items: { anyOf: [{ const: 'esm', title: 'ECMAScript modules' }, { const: 'cjs', title: 'Common JS' }] },
            },
          },
          required: ['formats'],
        },
      },
    }), ['--event', 'PreToolUse']);
    const reason = JSON.parse(result.stdout).permissionDecisionReason;
    expect(reason).toContain('"formats"');
    expect(reason).toContain('"esm"');
    expect(reason).toContain('"cjs"');
    expect(reason).not.toContain('"ECMAScript modules"');
  }, 20_000);

  it('accepts all for structured multi-select instead of treating it as cancellation', async () => {
    heard = 'all';
    const result = await run('notify', cli('cli-all', {
      toolName: 'ask_user',
      toolArgs: {
        message: 'Which targets?',
        requestedSchema: { properties: { targets: { type: 'array', items: { enum: ['API', 'Web'] } } } },
      },
    }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).permissionDecisionReason).toContain('"targets":["API","Web"]');
  }, 20_000);

  it('speaks the main structured question before asking for a property answer', async () => {
    heard = 'yes';
    const message = 'May I delete the production deployment?';
    const result = await run('notify', cli('cli-form-message', {
      toolName: 'ask_user',
      toolArgs: { message, requestedSchema: { properties: { answer: { type: 'boolean' } } } },
    }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).permissionDecisionReason).toContain('"answer":true');
    const spokenText = fs.readFileSync(audioTexts, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).join(' ');
    expect(spokenText).toContain(message);
    expect(spokenText.indexOf(message)).toBeLessThan(spokenText.indexOf('answer'));
  }, 20_000);

  it.each([['one', 'first'], ['Second', 'second']])('keeps numbered labels aligned with their original enum values: %s', async (answer, value) => {
    heard = answer;
    const result = await run('notify', cli('cli-numbered-label', {
      toolName: 'ask_user',
      toolArgs: {
        message: 'Choose format',
        requestedSchema: { properties: { format: { oneOf: [{ const: 'first', title: '1. ' }, { const: 'second', title: '2. Second' }] } } },
      },
    }), ['--event', 'PreToolUse']);
    expect(JSON.parse(result.stdout).permissionDecisionReason).toContain(`"format":"${value}"`);
  }, 20_000);

  it('does not treat a cancellation as a freeform answer', async () => {
    heard = 'cancel';
    const result = await run('notify', cli('cli-cancel-freeform', {
      toolName: 'ask_user', toolArgs: { question: 'What should we build?' },
    }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals.some((s) => s.event === 'ask')).toBe(true);
  }, 20_000);

  it.each([
    ['42', true],
    ['4.5', false],
    ['forty-ish', false],
  ])('validates a structured integer answer: %s', async (answer, accepted) => {
    heard = answer;
    const result = await run('notify', cli(`cli-number-${answer}`, {
      toolName: 'ask_user',
      toolArgs: {
        message: 'Set size',
        requestedSchema: { properties: { size: { type: 'integer' } }, required: ['size'] },
      },
    }), ['--event', 'PreToolUse']);
    if (accepted) expect(JSON.parse(result.stdout).permissionDecisionReason).toContain('"size":42');
    else expect(result.stdout).toBe('');
  }, 20_000);

  it('leaves unsupported structured questions open for manual completion', async () => {
    const result = await run('notify', cli('cli-form', {
      toolName: 'ask_user',
      toolArgs: { message: 'Choose', requestedSchema: { properties: { secret: { type: 'object' } }, required: ['secret'] } },
    }), ['--event', 'PreToolUse']);
    expect(result.stdout).toBe('');
    expect(signals.some((s) => s.event === 'ask')).toBe(false);
  });
});
