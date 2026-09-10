import * as vscode from 'vscode';
import { StatusBar } from './status';
import { Recorder, SAMPLE_RATE, CHANNELS } from './recorder';
import { Segmenter } from './segmenter';
import { listAudioDevices } from './devices';
import { transcribe, TranscribeError } from './transcriber';
import { refine, DEFAULT_REFINE_MODEL } from './refiner';
import { applyHooks, ClaudeSettings } from './claudeHooks';
import { inject, InjectorApi, Target } from './injector';
import { startServer, writeRegistry, removeRegistry, pipeName, Signal } from './signal';
import { audioLevel, pcmToWav } from './wav';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const SECRET_KEY = 'viVoice.groqApiKey';
const WELCOMED_KEY = 'viVoice.welcomed';
const GROQ_KEYS_URL = 'https://console.groq.com/keys';
const MAX_RECORD_MS = 120_000;
const MIN_RECORD_MS = 500;

/** Gửi Ctrl+V vào cửa sổ đang focus bằng SendKeys của Windows. */
function sendCtrlV(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")',
      ],
      { windowsHide: true, timeout: 5000 },
      (err) => (err ? reject(new Error(`Không gửi được Ctrl+V: ${err.message}`)) : resolve()),
    );
  });
}

function config() {
  const c = vscode.workspace.getConfiguration('viVoice');
  const typing = c.get<number>('typingDelayMs', 12);
  return {
    apiKey: (c.get<string>('groqApiKey', '') || '').trim(),
    voiceResponse: c.get<boolean>('voiceResponse', false),
    voice: c.get<string>('voice', 'vi-VN-HoaiMyNeural') || 'vi-VN-HoaiMyNeural',
    voiceRate: c.get<string>('voiceRate', '+0%') || '+0%',
    voiceNotify: c.get<boolean>('voiceNotify', true),
    voiceApprove: c.get<boolean>('voiceApprove', false),
    approveTimeoutSec: c.get<number>('voiceApproveTimeoutSec', 15),
    handsFree: c.get<boolean>('handsFree', false),
    handsFreeTimeoutSec: c.get<number>('handsFreeTimeoutSec', 20),
    ffmpegPath: c.get<string>('ffmpegPath', 'ffmpeg') || 'ffmpeg',
    micDevice: c.get<string>('micDevice', '') || undefined,
    typeDelayMs: typing > 0 ? typing : undefined,
    glossary: c.get<string[]>('glossary', []),
    language: c.get<string>('language', 'vi'),
    refine: c.get<boolean>('refine', true),
    refineModel: c.get<string>('refineModel', DEFAULT_REFINE_MODEL) || DEFAULT_REFINE_MODEL,
  };
}

/**
 * Terminal gửi mọi phím cho shell trừ các lệnh trong commandsToSkipShell.
 * Không có dòng này thì F6 trong terminal thành ký tự lạ thay vì bật Vi Voice.
 */
async function ensureTerminalSkipShell(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('terminal.integrated');
  const list = cfg.get<string[]>('commandsToSkipShell', []);
  if (list.includes('viVoice.toggle')) return;
  await cfg.update('commandsToSkipShell', [...list, 'viVoice.toggle'], vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    'Vi Voice: đã thêm "viVoice.toggle" vào setting terminal.integrated.commandsToSkipShell để phím tắt chạy được trong terminal.',
  );
}

/**
 * Một lần bấm F6 → nói → F6. Các cụm được gửi và chèn tuần tự trong lúc vẫn đang nghe.
 * auto: session hands-free do hook ra hiệu, tự tắt khi im lặng hoặc khi người dùng gửi prompt.
 */
interface Session {
  target: Target;
  segmenter: Segmenter;
  queue: Promise<void>;
  transcript: string;
  segments: number;
  auto: boolean;
  idleTimer?: NodeJS.Timeout;
}

export function activate(ctx: vscode.ExtensionContext): void {
  const status = new StatusBar();
  const out = vscode.window.createOutputChannel('Vi Voice');
  // Ghi thêm ra file để xem lại được sau khi đóng VS Code.
  const logFile = path.join(ctx.globalStorageUri.fsPath, 'vi-voice.log');
  fs.promises.mkdir(ctx.globalStorageUri.fsPath, { recursive: true }).catch(() => undefined);
  const log = (msg: string) => {
    const line = `${new Date().toLocaleTimeString('vi-VN')} ${msg}`;
    out.appendLine(line);
    fs.promises.appendFile(logFile, line + '\n').catch(() => undefined);
  };
  log(`--- Vi Voice ${ctx.extension.packageJSON.version} khởi động, log tại ${logFile}`);
  void ensureTerminalSkipShell().catch(() => undefined);
  let recorder = new Recorder(config());
  const api: InjectorApi = {
    activeTerminal: () => vscode.window.activeTerminal,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
    readClipboard: () => vscode.env.clipboard.readText(),
    pasteKeystroke: sendCtrlV,
  };

  let session: Session | undefined;
  let busy = false;
  // Hàng đợi chèn chữ của phiên gần nhất. Phiên mới nối vào sau để chữ không chen nhau
  // khi người dùng bấm F6 lại lúc cụm cuối của phiên trước còn đang gửi.
  let lastQueue: Promise<void> = Promise.resolve();
  let lastAudio: Uint8Array | undefined; // toàn bộ lần ghi cuối (debug)
  let failed: { wav: Uint8Array; target: Target; context: string } | undefined; // cụm gửi lỗi, để retry
  let maxTimer: NodeJS.Timeout | undefined;

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('viVoice.ffmpegPath') || e.affectsConfiguration('viVoice.micDevice')) {
        recorder.dispose();
        recorder = new Recorder(config());
      }
      if (
        e.affectsConfiguration('viVoice.voiceResponse') ||
        e.affectsConfiguration('viVoice.voice') ||
        e.affectsConfiguration('viVoice.voiceRate') ||
        e.affectsConfiguration('viVoice.voiceNotify') ||
        e.affectsConfiguration('viVoice.ffmpegPath')
      ) {
        void syncClaudeHooks().catch((err) => log(`lỗi đồng bộ hook: ${(err as Error).message}`));
      } else if (e.affectsConfiguration('viVoice')) {
        // Key, mic, từ điển, approve bằng giọng: hook đọc từ file cấu hình nên chỉ cần ghi lại file.
        void writeHookConfig().catch((err) => log(`lỗi ghi hook-config: ${(err as Error).message}`));
      }
    }),
  );

  async function setApiKey(): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      prompt: 'Groq API key (bắt đầu bằng gsk_). Lấy miễn phí tại console.groq.com/keys. Key được lưu vào setting viVoice.groqApiKey.',
      placeHolder: 'gsk_...',
      password: true,
      ignoreFocusOut: true,
    });
    const key = value?.trim();
    if (key) await vscode.workspace.getConfiguration('viVoice').update('groqApiKey', key, vscode.ConfigurationTarget.Global);
    return key || undefined;
  }

  /** Key trong Settings (Ctrl+,) được ưu tiên; không có thì dùng key đã lưu ở SecretStorage từ bản cũ. */
  async function resolveApiKey(): Promise<string | undefined> {
    return config().apiKey || (await ctx.secrets.get(SECRET_KEY)) || undefined;
  }

  async function getApiKey(): Promise<string | undefined> {
    return (await resolveApiKey()) ?? setApiKey();
  }

  /** Lần đầu cài, chưa có key: chỉ cho người dùng cách lấy và nhập key. */
  async function welcomeIfNoKey(): Promise<void> {
    if (ctx.globalState.get<boolean>(WELCOMED_KEY)) return;
    if (await resolveApiKey()) return;
    await ctx.globalState.update(WELCOMED_KEY, true);
    const pick = await vscode.window.showInformationMessage(
      'Vi Voice cần Groq API key (miễn phí) để nhận dạng giọng nói. Lấy key tại console.groq.com/keys rồi nhập vào đây.',
      'Nhập key',
      'Lấy key miễn phí',
    );
    if (pick === 'Nhập key') await setApiKey();
    else if (pick === 'Lấy key miễn phí') {
      await vscode.env.openExternal(vscode.Uri.parse(GROQ_KEYS_URL));
      await setApiKey();
    }
  }
  void welcomeIfNoKey().catch(() => undefined);

  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const hookScript = path.join(ctx.extensionPath, 'dist', 'claude-hook.js');
  const hookConfigPath = path.join(ctx.globalStorageUri.fsPath, 'hook-config.json');

  /** Ghi cấu hình cho hook: key Groq, mic, ffmpeg, từ điển, approve bằng giọng. */
  async function writeHookConfig(): Promise<void> {
    const cfg = config();
    const data = {
      apiKey: (await resolveApiKey()) ?? '',
      ffmpegPath: cfg.ffmpegPath,
      micDevice: cfg.micDevice ?? '',
      glossary: cfg.glossary,
      language: cfg.language,
      voiceApprove: cfg.voiceApprove,
      approveTimeoutSec: cfg.approveTimeoutSec,
      handsFree: cfg.handsFree,
      handsFreeTimeoutSec: cfg.handsFreeTimeoutSec,
      refine: cfg.refine,
      refineModel: cfg.refineModel,
    };
    await fs.promises.mkdir(path.dirname(hookConfigPath), { recursive: true });
    await fs.promises.writeFile(hookConfigPath, JSON.stringify(data, null, 2), 'utf8');
  }

  function playerPath(): string {
    const ff = config().ffmpegPath;
    if (ff === 'ffmpeg') return 'ffplay';
    const dir = path.dirname(ff);
    const ext = path.extname(ff);
    return path.join(dir, `ffplay${ext}`);
  }

  /** Ghi hook Stop + UserPromptSubmit vào ~/.claude/settings.json theo setting voiceResponse. */
  async function syncClaudeHooks(): Promise<void> {
    const cfg = config();
    let current: ClaudeSettings = {};
    try {
      current = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')) as ClaudeSettings;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`không đọc được ${claudeSettingsPath}: ${(err as Error).message}`);
        return;
      }
      if (!cfg.voiceResponse) return;
    }
    await writeHookConfig();
    const next = applyHooks(current, {
      enabled: cfg.voiceResponse,
      script: hookScript,
      voice: cfg.voice,
      rate: cfg.voiceRate,
      notify: cfg.voiceNotify,
      player: playerPath(),
      config: hookConfigPath,
    });
    const before = JSON.stringify(current);
    const after = JSON.stringify(next);
    if (before === after) return;
    await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    log(`hook Claude Code: ${cfg.voiceResponse ? 'đã bật' : 'đã tắt'} (${claudeSettingsPath})`);
    if (cfg.voiceResponse) {
      void vscode.window.showInformationMessage(
        'Vi Voice: đã bật đọc câu trả lời của Claude Code. Phiên Claude Code đang mở cần khởi động lại để nhận hook.',
      );
    }
  }
  void syncClaudeHooks().catch((err) => log(`lỗi đồng bộ hook: ${(err as Error).message}`));

  async function testVoice(): Promise<void> {
    const cfg = config();
    const file = path.join(os.tmpdir(), 'vi-voice-test-voice.txt');
    await fs.promises.writeFile(file, 'Xin chào, đây là giọng đọc của Vi Voice. Xong rồi, đã sửa ba file, test pass hết.', 'utf8');
    const child = spawn('node', [hookScript, 'play', file, '--voice', cfg.voice, '--rate', cfg.voiceRate, '--player', playerPath()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => void vscode.window.showErrorMessage(`Vi Voice: không chạy được node để đọc: ${e.message}`));
    child.unref();
    void vscode.window.showInformationMessage(`Vi Voice: đang đọc thử bằng giọng ${cfg.voice}. Không nghe thấy gì thì xem log tại %TEMP%\\vi-voice-tts\\hook.log`);
  }

  /** Gửi một cụm lên Groq và chèn kết quả. Trả về text đã chèn ('' nếu không có). */
  async function deliverSegment(wav: Uint8Array, target: Target, context: string): Promise<string> {
    const apiKey = await resolveApiKey();
    if (!apiKey) return '';
    let text: string;
    const cfg = config();
    const t0 = Date.now();
    try {
      text = await transcribe(wav, {
        apiKey,
        glossary: cfg.glossary,
        language: cfg.language,
        onRaw: (raw) => log(`whisper thô: ${JSON.stringify(raw)}`),
      });
    } catch (err) {
      log(`lỗi: ${(err as Error).message}`);
      failed = { wav, target, context };
      if (err instanceof TranscribeError && err.kind === 'auth') {
        const pick = await vscode.window.showErrorMessage(`Vi Voice: ${err.message}`, 'Nhập lại key');
        if (pick) await setApiKey();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const pick = await vscode.window.showErrorMessage(`Vi Voice: ${message}`, 'Gửi lại');
        if (pick) void vscode.commands.executeCommand('viVoice.retry');
      }
      return '';
    }
    log(`sau lọc (${Date.now() - t0}ms): ${JSON.stringify(text)}`);
    if (!text) return '';
    if (cfg.refine) {
      const t1 = Date.now();
      text = await refine(text, { apiKey, target, context, model: cfg.refineModel, glossary: cfg.glossary });
      log(`sau LLM (${Date.now() - t1}ms): ${JSON.stringify(text)}`);
    }
    if (!text) return '';
    const piece = (context ? ' ' : '') + text;
    const used = await inject(target, piece, api, { typeDelayMs: config().typeDelayMs });
    if (used === 'clipboard') {
      void vscode.window.showInformationMessage(`Vi Voice: đã copy vào clipboard: "${text}"`);
    }
    return piece;
  }

  /** Session hands-free: im lặng quá handsFreeTimeoutSec kể từ lúc mở hoặc cụm cuối thì tự tắt mic. */
  function armIdle(s: Session): void {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (session === s) {
        log('hands-free: im lặng, tắt mic');
        void toggle();
      }
    }, Math.max(5, config().handsFreeTimeoutSec) * 1000);
  }

  function enqueue(s: Session, pcm: Uint8Array): void {
    if (s.auto) armIdle(s);
    s.segments++;
    const wav = pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
    log(`cụm ${s.segments} (${(Recorder.durationMs(wav) / 1000).toFixed(1)}s) → ${s.target}`);
    s.queue = s.queue
      .then(async () => {
        s.transcript += await deliverSegment(wav, s.target, s.transcript);
      })
      .catch(() => undefined);
  }

  async function toggle(args?: { target?: Target; auto?: boolean }): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (!session) {
        if (!(await getApiKey())) return;
        const s: Session = {
          target: args?.target ?? 'clipboard',
          segmenter: undefined as unknown as Segmenter,
          queue: lastQueue,
          transcript: '',
          segments: 0,
          auto: !!args?.auto,
        };
        s.segmenter = new Segmenter({ sampleRate: SAMPLE_RATE }, (pcm) => enqueue(s, pcm));
        await recorder.start((chunk) => s.segmenter.push(chunk));
        session = s;
        status.set(s.auto ? 'listening' : 'recording');
        maxTimer = setTimeout(() => void vscode.commands.executeCommand('viVoice.toggle'), MAX_RECORD_MS);
        if (s.auto) armIdle(s);
        return;
      }
      clearTimeout(maxTimer);
      const s = session;
      clearTimeout(s.idleTimer);
      session = undefined;
      const audio = await recorder.stop();
      lastAudio = audio;
      s.segmenter.flush();
      status.set('transcribing');
      if (s.segments === 0 && Recorder.durationMs(audio) >= MIN_RECORD_MS) {
        const level = audioLevel(audio);
        void vscode.window.showWarningMessage(
          `Vi Voice: không nghe thấy tiếng nói (peak ${level.peakDb.toFixed(0)} dB, rms ${level.rmsDb.toFixed(0)} dB). ` +
            'Kiểm tra mic trong Windows Settings > Sound > Input, hoặc chạy lệnh "Vi Voice: Chọn micro".',
        );
      }
      // Không chờ các cụm cuối gửi xong: người dùng có thể bấm F6 nói tiếp ngay.
      lastQueue = s.queue.then(() => {
        if (!session) status.set('idle');
      });
    } catch (err) {
      session = undefined;
      status.set('idle');
      void vscode.window.showErrorMessage(`Vi Voice: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }

  async function retry(): Promise<void> {
    if (!failed) {
      void vscode.window.showInformationMessage('Vi Voice: không có cụm nào cần gửi lại');
      return;
    }
    const f = failed;
    failed = undefined;
    status.set('transcribing');
    try {
      await deliverSegment(f.wav, f.target, f.context);
    } finally {
      status.set('idle');
    }
  }

  async function pickMic(): Promise<void> {
    try {
      const devices = await listAudioDevices(config().ffmpegPath);
      if (devices.length === 0) {
        void vscode.window.showWarningMessage('Vi Voice: ffmpeg không thấy micro nào');
        return;
      }
      const pick = await vscode.window.showQuickPick(devices, { placeHolder: 'Chọn micro cho Vi Voice' });
      if (pick) {
        await vscode.workspace.getConfiguration('viVoice').update('micDevice', pick, vscode.ConfigurationTarget.Global);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Vi Voice: ${(err as Error).message}`);
    }
  }

  async function saveLastAudio(): Promise<void> {
    if (!lastAudio) {
      void vscode.window.showInformationMessage('Vi Voice: chưa có audio nào');
      return;
    }
    const file = path.join(os.tmpdir(), 'vi-voice-last.wav');
    await fs.promises.writeFile(file, lastAudio);
    const level = audioLevel(lastAudio);
    void vscode.window.showInformationMessage(
      `Vi Voice: đã lưu ${file} (${(Recorder.durationMs(lastAudio) / 1000).toFixed(1)}s, peak ${level.peakDb.toFixed(0)} dB)`,
    );
  }

  /** Bíp ngắn báo "nói đi" trước khi mở mic hands-free, cùng cách với hook. */
  function beep(): Promise<void> {
    return new Promise((resolve) => {
      const p = spawn(
        playerPath(),
        ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.18'],
        { stdio: 'ignore', windowsHide: true },
      );
      p.on('error', () => resolve());
      p.on('exit', () => resolve());
    });
  }

  /** Tín hiệu từ hook Claude Code: listen = Claude vừa đọc xong, mở mic; submitted = người dùng đã gửi, tắt mic. */
  async function onSignal(s: Signal): Promise<void> {
    log(`tín hiệu ${s.event} (session ${s.session || '-'})`);
    if (s.event === 'submitted') {
      if (session?.auto) await toggle();
      return;
    }
    if (!config().handsFree) return;
    if (session) {
      log('hands-free: mic đang bật sẵn, bỏ qua');
      return;
    }
    if (!vscode.window.activeTerminal) {
      log('hands-free: không có terminal đang mở, bỏ qua');
      return;
    }
    await beep();
    await toggle({ target: 'terminal', auto: true });
  }

  const pipe = pipeName(process.pid);
  const server = startServer(pipe, (s) => void onSignal(s).catch((err) => log(`lỗi tín hiệu: ${(err as Error).message}`)));
  const registerWindow = () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    try {
      writeRegistry({ pid: process.pid, pipe, folders });
      log(`đăng ký cửa sổ pid ${process.pid} cho hook: ${folders.join(', ') || '(không có folder)'}`);
    } catch (err) {
      log(`không ghi được đăng ký cửa sổ: ${(err as Error).message}`);
    }
  };
  registerWindow();

  ctx.subscriptions.push(
    status,
    out,
    { dispose: () => recorder.dispose() },
    vscode.workspace.onDidChangeWorkspaceFolders(registerWindow),
    {
      dispose: () => {
        removeRegistry(process.pid);
        server.close();
      },
    },
    vscode.commands.registerCommand('viVoice.toggle', toggle),
    vscode.commands.registerCommand('viVoice.setApiKey', setApiKey),
    vscode.commands.registerCommand('viVoice.retry', retry),
    vscode.commands.registerCommand('viVoice.pickMic', pickMic),
    vscode.commands.registerCommand('viVoice.saveLastAudio', saveLastAudio),
    vscode.commands.registerCommand('viVoice.testVoice', testVoice),
  );
}

export function deactivate(): void {}
