import * as vscode from 'vscode';
import { StatusBar, UsageBar } from './status';
import { flashWindowEx, learnForegroundWindow, acceptLearnedWindow, blinkTitleBar, applyTint, removeTint, shellColorFor, normalizeHex, shouldFlash, nextBlurAt, staleTintPlan, TINT, type ColorMap } from './attention';
import { Recorder, SAMPLE_RATE, CHANNELS } from './recorder';
import { Segmenter } from './segmenter';
import { listenOnce } from './listen';
import { listAudioDevices } from './devices';
import { transcribe, TranscribeError, repeatsTail } from './transcriber';
import { parseVoiceCommand } from './decision';
import { refine, DEFAULT_REFINE_MODEL, resetRefinePause } from './refiner';
import { pronounce } from './pronounce';
import { langOf, isAuto, effectiveVoice, usesVietPronunciation, DEFAULT_VOICE, type Lang } from './lang';
import { ELEVEN_DEFAULT_VOICE, ELEVEN_DEFAULT_MODEL, readUsage, usageFilePath } from './elevenlabs';
import { applyHooks, copilotHooksFile, copilotHookPaths, hooksEnabled, ClaudeSettings, HookOptions } from './claudeHooks';
import { inject, InjectorApi, Target } from './injector';
import { startServer, writeRegistry, removeRegistry, readRegistry, pipeName, Signal, acquireMic, releaseMic, micHolder, signalPid, canAutoListen, type AttentionReason } from './signal';
import { peerNotice } from './statusText';
import { audioLevel, pcmToWav } from './wav';
import { terminalForAgent, agentInWindow } from './proctree';
import { planMigration, planMuteMigration, configProperties } from './migrate';
import { checkRequirements } from './requirements';
import { installPlan, installLabel, manualHint, afterInstallNote, type Tool } from './installTool';
import { findExecutable } from './findTool';
import { needsTranslation, recapPromptsFor, translateRecap, type RecapTranslator } from './recapPrompt';
import { claudeCliTranslator } from './translate';
import { explainSelection, captureExplainSelection, explainPrompt, type ExplainResult } from './explain';
import { chatAutoApproveFrom } from './chatAutoApprove';
import { ChatPendingTracker, isAgentTerminal, type PendingChatTool } from './chatPending';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const SECRET_KEY = 'noIdle.groqApiKey';
const WELCOMED_KEY = 'noIdle.welcomed';
/** Bản dịch của noIdle.recapPrompt: { hash của text nguồn, bản dịch }. Đổi text là hash khác, dịch lại. */
const RECAP_CACHE_KEY = 'noIdle.recapPromptTranslation';
const GROQ_KEYS_URL = 'https://console.groq.com/keys';
/** Dòng báo cửa sổ khác cần người dùng giữ trên status bar bao lâu (bấm vào để nhảy sang). */
const PEER_NOTICE_MS = 15_000;
const MAX_RECORD_MS = 120_000;
const MIN_RECORD_MS = 500;
/** Hands-free: tổng chữ ít hơn chừng này từ thì không tự gửi, tránh gửi nhầm tiếng động hay một từ lẻ. */
const AUTO_SEND_MIN_WORDS = 3;
/** F6 ở cửa sổ này khi cửa sổ khác đang nghe: chờ cửa sổ kia trả mic tối đa chừng này. */
const MIC_HANDOVER_MS = 2500;
/** Hands-free: VAD vẫn thấy tiếng nhưng quá chừng này kể từ chữ cuối mà không ra chữ mới thì coi là tiếng ồn, gửi luôn. */
const NOISE_GRACE_MS = 8000;
/** Nghe approve/chọn: bỏ chừng này ms audio sau bíp, loa còn vọng đuôi bíp mà mic đã mở sẵn. */
const ASK_GUARD_MS = 250;

/**
 * Gửi lệnh dán vào cửa sổ đang focus: Ctrl+V bằng SendKeys trên Windows, Cmd+V bằng System Events trên macOS
 * (macOS cần cấp quyền Accessibility cho VS Code; bị chặn thì lỗi, chữ vẫn nằm trong clipboard).
 */
function sendCtrlV(): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: 5000 },
        (err) => (err ? reject(new Error(`Không gửi được Cmd+V: ${err.message}`)) : resolve()),
      );
    });
  }
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
  const c = vscode.workspace.getConfiguration('noIdle');
  const typing = c.get<number>('typingDelayMs', 12);
  return {
    apiKey: (c.get<string>('groqApiKey', '') || '').trim(),
    voiceResponse: c.get<boolean>('voiceResponse', true),
    voice: c.get<string>('voice', DEFAULT_VOICE) || DEFAULT_VOICE,
    voiceRate: c.get<string>('voiceRate', '+0%') || '+0%',
    ttsProvider: (c.get<string>('ttsProvider', 'edge') === 'elevenlabs' ? 'elevenlabs' : 'edge') as 'edge' | 'elevenlabs',
    elevenLabsApiKey: (c.get<string>('elevenLabsApiKey', '') || '').trim(),
    elevenLabsVoiceId: (c.get<string>('elevenLabsVoiceId', '') || '').trim() || ELEVEN_DEFAULT_VOICE,
    elevenLabsModel: (c.get<string>('elevenLabsModel', '') || '').trim() || ELEVEN_DEFAULT_MODEL,
    voiceNotify: c.get<boolean>('voiceNotify', true),
    approveTimeoutSec: c.get<number>('voiceApproveTimeoutSec', 15),
    handsFree: c.get<boolean>('handsFree', false),
    handsFreeTimeoutSec: c.get<number>('handsFreeTimeoutSec', 20),
    handsFreeAutoSend: c.get<boolean>('handsFreeAutoSend', true),
    handsFreeSendDelaySec: c.get<number>('handsFreeSendDelaySec', 2.5),
    ffmpegPath: c.get<string>('ffmpegPath', 'ffmpeg') || 'ffmpeg',
    micDevice: c.get<string>('micDevice', '') || undefined,
    // Recorder đọc trường device; trước đây chỉ có micDevice nên mic đã chọn bị bỏ qua, luôn lấy thiết bị đầu tiên.
    device: c.get<string>('micDevice', '') || undefined,
    typeDelayMs: typing > 0 ? typing : undefined,
    glossary: c.get<string[]>('glossary', []),
    pronunciations: c.get<Record<string, string>>('pronunciations', {}) || {},
    voiceSayWorkspace: c.get<'auto' | 'always' | 'never'>('voiceSayWorkspace', 'auto') || 'auto',
    voiceStyle: (c.get<string>('voiceStyle', 'recap') === 'announce' ? 'announce' : 'recap') as 'recap' | 'announce',
    /** Thân hướng dẫn recap người dùng tự sửa; rỗng là bản mặc định (recapPromptsFor xử lý). */
    recapPrompt: (c.get<string>('recapPrompt', '') || '').trim(),
    attentionFlash: c.get<boolean>('attentionFlash', true),
    attentionColor: c.get<boolean>('attentionColor', true),
    attentionTintColor: normalizeHex(c.get<string>('attentionTintColor', ''), TINT.activeBackground),
    language: c.get<string>('language', 'vi'),
    /** auto: mic để Whisper tự nhận diện, giao diện và giọng theo ngôn ngữ nghe được gần nhất. */
    auto: isAuto(c.get<string>('language', 'vi')),
    lang: langOf(c.get<string>('language', 'vi')),
    refine: c.get<boolean>('refine', true),
    refineModel: c.get<string>('refineModel', DEFAULT_REFINE_MODEL) || DEFAULT_REFINE_MODEL,
  };
}

/**
 * Terminal gửi mọi phím cho shell trừ các lệnh trong commandsToSkipShell.
 * Không có dòng này thì F6 trong terminal thành ký tự lạ thay vì bật NoIdle.
 */
async function ensureTerminalSkipShell(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('terminal.integrated');
  const list = cfg.get<string[]>('commandsToSkipShell', []);
  const missing = ['noIdle.toggle', 'noIdle.skipSpeech', 'noIdle.explainSelection'].filter((c) => !list.includes(c));
  if (missing.length === 0) return;
  await cfg.update('commandsToSkipShell', [...list, ...missing], vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    `NoIdle: đã thêm ${missing.map((c) => `"${c}"`).join(', ')} vào setting terminal.integrated.commandsToSkipShell để phím tắt chạy được trong terminal.`,
  );
}

/**
 * 1.x → 2.0: extension đổi tên từ Vi Voice, id setting viVoice.* thành noIdle.*. Chép giá trị người dùng đã đặt sang id mới
 * (API key, bảng phát âm, giọng...), xoá key cũ (còn đăng ký dạng deprecated trong package.json để VS Code cho xoá),
 * chuyển key trong secrets và cờ welcomed, xoá file hook Copilot cũ, dọn id lệnh cũ khỏi commandsToSkipShell.
 */
async function migrateFromViVoice(ctx: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  const props = configProperties(ctx.extension.packageJSON.contributes);
  const keys = Object.keys(props).filter((k) => k.startsWith('noIdle.')).map((k) => k.slice('noIdle.'.length));
  const oldCfg = vscode.workspace.getConfiguration('viVoice');
  const newCfg = vscode.workspace.getConfiguration('noIdle');
  const plan = planMigration(keys, (k) => oldCfg.inspect(k)?.globalValue, (k) => newCfg.inspect(k)?.globalValue);
  for (const [k, v] of plan.set) await newCfg.update(k, v, vscode.ConfigurationTarget.Global);
  for (const k of plan.clear) await oldCfg.update(k, undefined, vscode.ConfigurationTarget.Global);
  if (plan.clear.length) log(`migrate: chép ${plan.set.length} setting viVoice.* sang noIdle.*, xoá ${plan.clear.length} key cũ`);
  // 1.0.11: voiceApprove gộp vào handsFree. Người đang bật approve bằng giọng mà chưa đặt handsFree thì bật handsFree cho họ.
  const oldApprove = newCfg.inspect<boolean>('voiceApprove')?.globalValue;
  if (oldApprove !== undefined) {
    if (oldApprove && newCfg.inspect<boolean>('handsFree')?.globalValue === undefined) {
      await newCfg.update('handsFree', true, vscode.ConfigurationTarget.Global);
    }
    await newCfg.update('voiceApprove', undefined, vscode.ConfigurationTarget.Global);
    log(`migrate: noIdle.voiceApprove=${oldApprove} gộp vào handsFree`);
  }
  // 1.0.19: bỏ voiceMute; tắt Voice Response giờ là im lặng mà vẫn nháy, có hiệu lực ngay.
  const oldMute = newCfg.inspect<boolean>('voiceMute')?.globalValue;
  const mute = planMuteMigration(oldMute);
  if (mute.voiceResponse === false) await newCfg.update('voiceResponse', false, vscode.ConfigurationTarget.Global);
  if (mute.clearMute) {
    await newCfg.update('voiceMute', undefined, vscode.ConfigurationTarget.Global);
    log(`migrate: noIdle.voiceMute=${oldMute}${mute.voiceResponse === false ? ' → voiceResponse tắt' : ''}, xoá voiceMute`);
  }
  const oldSecret = await ctx.secrets.get('viVoice.groqApiKey');
  if (oldSecret) {
    if (!(await ctx.secrets.get(SECRET_KEY))) await ctx.secrets.store(SECRET_KEY, oldSecret);
    await ctx.secrets.delete('viVoice.groqApiKey');
    log('migrate: chuyển API key trong secrets');
  }
  if (ctx.globalState.get<boolean>('viVoice.welcomed')) {
    await ctx.globalState.update(WELCOMED_KEY, true);
    await ctx.globalState.update('viVoice.welcomed', undefined);
  }
  await fs.promises.unlink(path.join(os.homedir(), '.copilot', 'hooks', 'vi-voice.json')).catch(() => undefined);
  const term = vscode.workspace.getConfiguration('terminal.integrated');
  const list = term.get<string[]>('commandsToSkipShell', []);
  const cleaned = list.filter((c) => !c.startsWith('viVoice.'));
  if (cleaned.length !== list.length) await term.update('commandsToSkipShell', cleaned, vscode.ConfigurationTarget.Global);
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
  /** Hands-free: hẹn giờ tự gửi sau cụm cuối. */
  sendTimer?: NodeJS.Timeout;
  /** Người dùng vừa nói "gửi": gửi ngay khi cụm này chèn xong. */
  sendNow?: boolean;
  finishing?: boolean;
  /** Terminal chốt lúc bắt đầu phiên; mọi cụm và Enter đều vào đây dù người dùng đổi terminal giữa chừng. */
  terminal?: vscode.Terminal;
  /** Editor chốt lúc bắt đầu phiên; chèn qua editor.edit của nó, không qua lệnh type vào chỗ đang focus. */
  editor?: vscode.TextEditor;
  /** Lần cuối mic thấy tiếng nói; hands-free không tự gửi khi người dùng vẫn đang nói dở một cụm dài. */
  lastSpeechAt: number;
  /** Lần cuối một cụm cho ra chữ thật (sau lọc). Đồng hồ im lặng hands-free tính từ đây, không tính theo cụm âm thanh. */
  lastTextAt: number;
  /** Số cụm đã qua Whisper (kể cả không ra chữ); segments - delivered = cụm còn đang chờ. */
  delivered: number;
}

export function activate(ctx: vscode.ExtensionContext): void {
  const status = new StatusBar();
  // Credit ElevenLabs: hook ghi file sau mỗi lượt đọc, extension theo dõi file và hiện cạnh nút mic, không đọc thành tiếng.
  const usageBar = new UsageBar();
  const usageFile = usageFilePath();
  const refreshUsage = () => usageBar.update(config().ttsProvider === 'elevenlabs' ? readUsage(usageFile) : undefined);
  fs.watchFile(usageFile, { interval: 2000 }, refreshUsage);
  refreshUsage();
  ctx.subscriptions.push(usageBar, { dispose: () => fs.unwatchFile(usageFile, refreshUsage) });
  const out = vscode.window.createOutputChannel('NoIdle');
  // Ghi thêm ra file để xem lại được sau khi đóng VS Code.
  const logFile = path.join(ctx.globalStorageUri.fsPath, 'noidle.log');
  fs.promises.mkdir(ctx.globalStorageUri.fsPath, { recursive: true }).catch(() => undefined);
  // Mọi cửa sổ ghi chung một file: gắn tên workspace để biết dòng nào của cửa sổ nào.
  const windowTag = () => vscode.workspace.name ?? (path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') || `pid ${process.pid}`);
  const log = (msg: string) => {
    const line = `${new Date().toLocaleTimeString('vi-VN')} [${windowTag()}] ${msg}`;
    out.appendLine(line);
    fs.promises.appendFile(logFile, line + '\n').catch(() => undefined);
  };
  log(`--- NoIdle ${ctx.extension.packageJSON.version} khởi động, log tại ${logFile}`);
  void ensureTerminalSkipShell().catch(() => undefined);
  /**
   * Đường dẫn tuyệt đối của ffmpeg/ffplay (xem findTool.ts). Setting để 'ffmpeg' thì tìm theo PATH của VS Code,
   * PATH trong registry và thư mục winget/choco/scoop/Homebrew; ghi vào hook để Claude chạy từ shell nào cũng thấy,
   * và Recorder cũng dùng nên cài ffmpeg xong không cần mở lại VS Code. Không thấy thì giữ tên trần như trước.
   */
  const tools = { ffmpeg: config().ffmpegPath, ffplay: playerPath(), node: 'node' };
  async function resolveTools(): Promise<boolean> {
    const ff = config().ffmpegPath;
    const bare = ff === 'ffmpeg';
    const next = {
      ffmpeg: bare ? (await findExecutable('ffmpeg')) ?? ff : ff,
      ffplay: bare ? (await findExecutable('ffplay')) ?? 'ffplay' : playerPath(),
      // Hook phát tiếng do Claude/Copilot chạy từ shell có node; còn F7 (skip), đọc thử và báo approve của Chat
      // là extension host tự spawn node. Extension host có thể giữ PATH cũ không có node (winget/installer cập nhật
      // PATH cho cửa sổ mở sau), nên tìm đường dẫn tuyệt đối như ffmpeg để spawn không lỗi ENOENT âm thầm.
      node: (await findExecutable('node')) ?? 'node',
    };
    const changed = next.ffmpeg !== tools.ffmpeg || next.ffplay !== tools.ffplay || next.node !== tools.node;
    if (changed) log(`ffmpeg: ${next.ffmpeg}; ffplay: ${next.ffplay}; node: ${next.node}`);
    Object.assign(tools, next);
    return changed;
  }
  const recorderOptions = () => ({ ...config(), ffmpegPath: tools.ffmpeg });
  let recorder = new Recorder(recorderOptions());
  const api: InjectorApi = {
    activeTerminal: () => vscode.window.activeTerminal,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
    readClipboard: () => vscode.env.clipboard.readText(),
    pasteKeystroke: sendCtrlV,
  };

  let session: Session | undefined;
  let busy = false;
  // Ngôn ngữ Whisper nghe được gần nhất, chỉ dùng khi noIdle.language là auto.
  let heardLang: Lang = 'vi';
  /** Ngôn ngữ cho giao diện, câu mồi Whisper, LLM sửa câu và đọc thử: setting cố định, hoặc ngôn ngữ nghe được gần nhất khi auto. */
  const uiLang = (): Lang => (config().auto ? heardLang : config().lang);
  // Đang nghe một câu cho hook (approve / chọn đáp án); F6 và tín hiệu listen bị bỏ qua trong lúc này.
  let asking = false;
  let askingReason: Signal['reason'];
  // Tên agent của tín hiệu gần nhất, để status bar ghi "Copilot đang nghe" thay vì luôn "Claude".
  let agentLabel = 'Claude';
  // Huỷ lượt nghe approve / chọn đáp án đang chạy (khi người dùng gửi prompt hoặc cửa sổ khác xin mic).
  let cancelAsk: (() => void) | undefined;
  // Hàng đợi chèn chữ của phiên gần nhất. Phiên mới nối vào sau để chữ không chen nhau
  // khi người dùng bấm F6 lại lúc cụm cuối của phiên trước còn đang gửi.
  let lastQueue: Promise<void> = Promise.resolve();
  let lastAudio: Uint8Array | undefined; // toàn bộ lần ghi cuối (debug)
  // Cụm gửi lỗi, để retry; giữ cả terminal đã chốt để "Gửi lại" không đi theo terminal đang focus lúc đó.
  let failed: { wav: Uint8Array; target: Target; context: string; terminal?: vscode.Terminal; editor?: vscode.TextEditor } | undefined;
  let maxTimer: NodeJS.Timeout | undefined;

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const cfg = config();
      if (asking && !canAutoListen({ event: 'ask', reason: askingReason }, cfg)) cancelAsk?.();
      if (session?.auto && !canAutoListen({ event: 'listen' }, cfg)) {
        void toggle().catch((err) => log(`không dừng được mic: ${(err as Error).message}`));
      }
      if (e.affectsConfiguration('noIdle.handsFree') && cfg.handsFree) void askKeyForMicFeature('Hands Free').catch(() => undefined);
      if (e.affectsConfiguration('noIdle.recapPrompt')) void ensureRecapTranslation();
      if (e.affectsConfiguration('noIdle.ffmpegPath') || e.affectsConfiguration('noIdle.micDevice')) {
        recorder.dispose();
        recorder = new Recorder(recorderOptions());
      }
      if (
        // Cài hay gỡ hook chỉ đổi khi bật/tắt hết đọc, nháy và đổi màu; syncHooks ghi lại hook-config trước nên
        // bật tắt từng tính năng vẫn có hiệu lực ngay ở lượt sau.
        e.affectsConfiguration('noIdle.voiceResponse') ||
        e.affectsConfiguration('noIdle.handsFree') ||
        e.affectsConfiguration('noIdle.attentionFlash') ||
        e.affectsConfiguration('noIdle.attentionColor') ||
        e.affectsConfiguration('noIdle.voice') ||
        e.affectsConfiguration('noIdle.voiceRate') ||
        e.affectsConfiguration('noIdle.ffmpegPath')
      ) {
        void syncHooks().catch((err) => log(`lỗi đồng bộ hook: ${(err as Error).message}`));
      } else if (e.affectsConfiguration('noIdle') || e.affectsConfiguration('chat.tools')) {
        if (e.affectsConfiguration('noIdle.ttsProvider')) refreshUsage();
        // Approve bằng giọng, hands-free, auto-approve của Chat: hook đọc từ file cấu hình nên chỉ cần ghi lại file.
        void writeHookConfig().catch((err) => log(`lỗi ghi hook-config: ${(err as Error).message}`));
      }
    }),
  );

  async function setApiKey(): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      prompt: 'Groq API key (bắt đầu bằng gsk_). Lấy miễn phí tại console.groq.com/keys. Key được lưu vào setting noIdle.groqApiKey.',
      placeHolder: 'gsk_...',
      password: true,
      ignoreFocusOut: true,
    });
    const key = value?.trim();
    if (key) await vscode.workspace.getConfiguration('noIdle').update('groqApiKey', key, vscode.ConfigurationTarget.Global);
    return key || undefined;
  }

  async function setElevenLabsApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: 'ElevenLabs API key. Lấy tại elevenlabs.io/app/settings/api-keys (gói Free có 10.000 credit mỗi tháng). Key được lưu vào setting noIdle.elevenLabsApiKey và noIdle.ttsProvider chuyển sang elevenlabs.',
      placeHolder: 'sk_...',
      password: true,
      ignoreFocusOut: true,
    });
    const key = value?.trim();
    if (!key) return;
    const c = vscode.workspace.getConfiguration('noIdle');
    await c.update('elevenLabsApiKey', key, vscode.ConfigurationTarget.Global);
    await c.update('ttsProvider', 'elevenlabs', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('NoIdle: đã lưu key ElevenLabs và chuyển giọng đọc sang ElevenLabs. Chạy "NoIdle: Đọc thử giọng" để nghe.');
  }

  /** Key trong Settings (Ctrl+,) được ưu tiên; không có thì dùng key đã lưu ở SecretStorage từ bản cũ. */
  async function resolveApiKey(): Promise<string | undefined> {
    return config().apiKey || (await ctx.secrets.get(SECRET_KEY)) || undefined;
  }

  async function getApiKey(): Promise<string | undefined> {
    return (await resolveApiKey()) ?? setApiKey();
  }

  /**
   * Chỉ hỏi key khi người dùng bật tính năng cần mic (Hands Free) mà chưa có key; không thì mic mở mà
   * lặng lẽ không nhận dạng được. Chỉ nghe đọc thì không cần key nên lúc cài không hỏi. F6 tự hỏi qua getApiKey.
   */
  async function askKeyForMicFeature(feature: string): Promise<void> {
    if (await resolveApiKey()) return;
    const pick = await vscode.window.showInformationMessage(
      `NoIdle: ${feature} cần Groq API key (miễn phí) để nhận dạng giọng nói. Lấy key tại console.groq.com/keys rồi nhập vào đây.`,
      'Nhập key',
      'Lấy key miễn phí',
    );
    if (pick === 'Nhập key') await setApiKey();
    else if (pick === 'Lấy key miễn phí') {
      await vscode.env.openExternal(vscode.Uri.parse(GROQ_KEYS_URL));
      await setApiKey();
    }
  }

  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const hookScript = path.join(ctx.extensionPath, 'dist', 'claude-hook.js');
  // Hook trong settings trỏ vào bản sao ở globalStorage: thư mục extension có số version và bị xoá khi
  // update, nên trỏ thẳng vào đó thì hook lỗi MODULE_NOT_FOUND tới khi VS Code mở lại và ghi lại đường dẫn.
  const installedHookScript = path.join(ctx.globalStorageUri.fsPath, 'claude-hook.js');
  const hookConfigPath = path.join(ctx.globalStorageUri.fsPath, 'hook-config.json');
  const copilotHooksPaths = copilotHookPaths(os.homedir(), process.env.COPILOT_HOME);

  /** Ghi cấu hình cho hook: approve bằng giọng và hands-free. Hook không tự mở mic nên không cần key hay mic. */
  async function writeHookConfig(): Promise<void> {
    const cfg = config();
    const data = {
      voiceResponse: cfg.voiceResponse,
      voiceNotify: cfg.voiceNotify,
      attentionFlash: cfg.attentionFlash,
      voice: cfg.voice,
      approveTimeoutSec: cfg.approveTimeoutSec,
      handsFree: cfg.handsFree,
      pronunciations: cfg.pronunciations,
      voiceSayWorkspace: cfg.voiceSayWorkspace,
      voiceStyle: cfg.voiceStyle,
      language: cfg.language,
      recapPrompt: recapPromptsFor(cfg.recapPrompt, cachedTranslation(cfg.recapPrompt)),
      // Setting auto-approve của Copilot Chat (đã gộp mặc định + user + workspace): Hands Free tắt thì hook chỉ đọc
      // "cần approve" cho lệnh terminal VS Code không tự duyệt, kèm 'ask' để hộp thoại chắc chắn hiện.
      chatAutoApprove: chatAutoApproveFrom(
        (key) => vscode.workspace.getConfiguration().get(key),
        (key) => vscode.workspace.getConfiguration().inspect(key)?.defaultValue,
      ),
      tts: {
        provider: cfg.ttsProvider,
        elevenLabsApiKey: cfg.elevenLabsApiKey,
        elevenLabsVoiceId: cfg.elevenLabsVoiceId,
        elevenLabsModel: cfg.elevenLabsModel,
      },
    };
    await fs.promises.mkdir(path.dirname(hookConfigPath), { recursive: true });
    await fs.promises.writeFile(hookConfigPath, JSON.stringify(data, null, 2), 'utf8');
  }

  const recapHash = (text: string): string => createHash('sha1').update(text.trim()).digest('hex');

  function cachedTranslation(text: string): string | undefined {
    const cache = ctx.globalState.get<{ hash: string; text: string }>(RECAP_CACHE_KEY);
    return cache?.hash === recapHash(text) ? cache.text : undefined;
  }

  /** Copilot Chat trong VS Code (vscode.lm): chạy trong tiến trình, lần đầu VS Code hỏi người dùng cho phép NoIdle dùng model. */
  function copilotLmTranslator(): RecapTranslator {
    return {
      name: 'copilot',
      async run(prompt) {
        const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (!model) return undefined;
        const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, new vscode.CancellationTokenSource().token);
        let out = '';
        for await (const chunk of res.text) out += chunk;
        return out;
      },
    };
  }

  let translating: Promise<void> | undefined;
  /**
   * Dịch noIdle.recapPrompt sang thứ tiếng còn lại khi text đổi (so hash với cache), chạy nền và im lặng:
   * Copilot Chat → Claude Code CLI → chịu, hook dùng nguyên văn cộng câu ngôn ngữ. Xong thì ghi lại hook-config.
   */
  function ensureRecapTranslation(): Promise<void> {
    if (translating) return translating;
    translating = (async () => {
      const text = config().recapPrompt;
      if (!needsTranslation(text) || cachedTranslation(text)) return;
      const hash = recapHash(text);
      log(`recapPrompt: text mới (${hash.slice(0, 8)}), dịch nền`);
      const result = await translateRecap(text, [copilotLmTranslator(), claudeCliTranslator()]);
      if (!result) {
        log('recapPrompt: không dịch được (không có Copilot Chat lẫn Claude Code), hook dùng nguyên văn');
        return;
      }
      // Người dùng đổi text trong lúc đang dịch thì bản này lỗi thời: lần gọi sau (setting đổi) sẽ dịch lại.
      if (recapHash(config().recapPrompt) !== hash) return;
      await ctx.globalState.update(RECAP_CACHE_KEY, { hash, text: result.text });
      log(`recapPrompt: dịch xong bằng ${result.via} (${result.text.length} ký tự)`);
      await writeHookConfig();
    })()
      .catch((err) => log(`recapPrompt: lỗi dịch: ${(err as Error).message}`))
      .finally(() => (translating = undefined));
    return translating;
  }

  /** ffplay theo setting Ffmpeg Path: setting để 'ffmpeg' thì 'ffplay' (resolveTools sẽ tìm đường dẫn tuyệt đối). */
  function playerPath(): string {
    const ff = config().ffmpegPath;
    if (ff === 'ffmpeg') return 'ffplay';
    const dir = path.dirname(ff);
    const ext = path.extname(ff);
    return path.join(dir, `ffplay${ext}`);
  }

  /** Tuỳ chọn hook chung cho Claude Code và Copilot, lấy từ settings hiện tại. */
  function hookOptions(): HookOptions {
    const cfg = config();
    return {
      enabled: hooksEnabled(cfg),
      script: hookScript,
      // Hook tự đổi giọng vi-VN sang giọng đa ngôn ngữ khi đọc tiếng Anh (theo ngôn ngữ của từng phiên).
      voice: cfg.voice,
      rate: cfg.voiceRate,
      // Hook approve/chọn đáp án luôn cài: nó còn nháy cửa sổ khi agent chờ bạn; đọc hay không do hook-config quyết.
      notify: true,
      player: tools.ffplay,
      config: hookConfigPath,
    };
  }

  /**
   * Cài ffmpeg hay Node.js giúp bằng winget (Windows) hay brew (macOS) trong terminal của VS Code cho người dùng thấy
   * tiến trình. Đóng terminal: ffmpeg thì tìm lại đường dẫn và đồng bộ hook ngay; Node.js thì nhắc mở lại VS Code
   * vì tiến trình đang chạy giữ PATH cũ. Linux chỉ hướng dẫn cài tay.
   */
  function installTools(tools: Tool[]): void {
    const cmds = installPlan(tools);
    if (!cmds.length) {
      void vscode.window.showInformationMessage(manualHint(tools), 'Hướng dẫn cài').then((pick) => {
        if (pick) void vscode.env.openExternal(vscode.Uri.parse('https://github.com/trongld230289/noidle#readme'));
      });
      return;
    }
    const terminal = vscode.window.createTerminal({ name: `NoIdle: ${installLabel(tools).toLowerCase()}` });
    terminal.show();
    // Gửi từng lệnh, shell chạy lần lượt (không nối bằng && vì PowerShell 5 không có).
    for (const cmd of cmds) terminal.sendText(cmd, true);
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) return;
      sub.dispose();
      warnedMissing = '';
      const note = afterInstallNote(tools);
      if (note) void vscode.window.showInformationMessage(note);
      void syncHooks().catch((err) => log(`lỗi đồng bộ hook sau khi ${installLabel(tools).toLowerCase()}: ${(err as Error).message}`));
    });
    ctx.subscriptions.push(sub);
  }
  const installFfmpeg = () => installTools(['ffmpeg']);
  const installNode = () => installTools(['node']);

  /** Chép dist/claude-hook.js ra globalStorage (ghi file tạm rồi rename). Trả về đường dẫn hook nên dùng. */
  async function installHookScript(): Promise<string> {
    try {
      const bundled = await fs.promises.readFile(hookScript);
      const current = await fs.promises.readFile(installedHookScript).catch(() => undefined);
      if (!current?.equals(bundled)) {
        const tmp = `${installedHookScript}.${process.pid}.tmp`;
        await fs.promises.mkdir(path.dirname(installedHookScript), { recursive: true });
        await fs.promises.writeFile(tmp, bundled);
        await fs.promises.rename(tmp, installedHookScript);
        log(`đã chép hook script ra ${installedHookScript}`);
      }
      return installedHookScript;
    } catch (err) {
      log(`không chép được hook script, dùng bản trong extension: ${(err as Error).message}`);
      return hookScript;
    }
  }

  /** Đã báo thiếu node/ffplay trong lần chạy này chưa, để không hiện lại mỗi lần đổi setting. */
  let warnedMissing = '';

  /**
   * Hook là script node: thiếu node thì Claude Code và Copilot Chat báo lỗi hook ở mọi lượt, nên coi như voiceResponse
   * tắt (gỡ hook) và báo cách cài. Thiếu ffplay thì hook vẫn nháy cửa sổ, chỉ không có tiếng: vẫn ghi hook, báo một lần.
   */
  async function hooksAllowed(opts: HookOptions): Promise<boolean> {
    if (!opts.enabled) return true;
    const have = await checkRequirements(opts.player);
    // Thiếu ffplay chỉ đáng báo khi người dùng muốn nghe đọc. Máy mới thường thiếu cả hai: báo và cài một lần.
    const tools: Tool[] = [];
    if (!have.node) tools.push('node');
    if (!have.player && config().voiceResponse) tools.push('ffmpeg');
    const missing = tools.join('+');
    // Popup chỉ hiện một lần mỗi phiên; nút status bar nhắc tới khi có ffplay, bấm là cài.
    status.missingPlayer(!have.node ? false : tools.includes('ffmpeg'));
    if (!missing) return true;
    if (warnedMissing !== missing) {
      warnedMissing = missing;
      const text = !have.node
        ? `NoIdle: cần Node.js để đọc câu trả lời và nháy cửa sổ khi agent xong${tools.includes('ffmpeg') ? ', và ffmpeg để có tiếng' : ''}. Cài xong thì mở lại VS Code.`
        : 'NoIdle: không thấy ffplay (đi kèm ffmpeg) nên chỉ nháy cửa sổ, không đọc thành tiếng. Cài ffmpeg, hoặc điền đường dẫn vào Ffmpeg Path.';
      log(`thiếu ${missing}: ${!have.node ? 'không ghi hook' : 'hook chỉ nháy cửa sổ'}`);
      const button = installLabel(tools);
      const install = installPlan(tools).length ? [button] : [];
      void vscode.window.showWarningMessage(text, ...install, 'Hướng dẫn cài').then((pick) => {
        if (pick === button) installTools(tools);
        else if (pick) void vscode.env.openExternal(vscode.Uri.parse('https://github.com/trongld230289/noidle#readme'));
      });
    }
    return have.node;
  }

  /** Đồng bộ hook cho Claude Code, Copilot Chat và Copilot CLI. */
  async function syncHooks(): Promise<void> {
    await writeHookConfig();
    // Tìm ffmpeg/ffplay trước khi ghi hook; đường dẫn ffmpeg đổi thì thay Recorder (lúc mic đang rảnh).
    if ((await resolveTools()) && !recorder.recording && !session && !asking) {
      recorder.dispose();
      recorder = new Recorder(recorderOptions());
    }
    const wanted = { ...hookOptions(), script: await installHookScript() };
    const opts = (await hooksAllowed(wanted)) ? wanted : { ...wanted, enabled: false };
    await syncClaudeHooks(opts);
    await syncCopilotHooks(opts);
  }

  /**
   * Copilot Chat trong VS Code (từ 1.110) đọc hook ở ~/.copilot/hooks/*.json nhưng mặc định không đọc
   * ~/.claude/settings.json, nên ghi một file riêng. Tắt voiceResponse thì xoá file.
   */
  async function syncCopilotHooks(opts: HookOptions): Promise<void> {
    const data = opts.enabled ? JSON.stringify(copilotHooksFile(opts), null, 2) + '\n' : '';
    for (const copilotHooksPath of copilotHooksPaths) {
      let current = '';
      try {
        current = await fs.promises.readFile(copilotHooksPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`không đọc được ${copilotHooksPath}: ${(err as Error).message}`);
          continue;
        }
      }
      if (current === data) continue;
      if (data) {
        await fs.promises.mkdir(path.dirname(copilotHooksPath), { recursive: true });
        await fs.promises.writeFile(copilotHooksPath, data, 'utf8');
      } else {
        await fs.promises.rm(copilotHooksPath, { force: true });
      }
      log(`hook Copilot Chat/CLI: ${opts.enabled ? 'đã bật' : 'đã tắt'} (${copilotHooksPath})`);
    }
  }

  /** Ghi hook Stop + UserPromptSubmit vào ~/.claude/settings.json theo setting voiceResponse. */
  async function syncClaudeHooks(opts: HookOptions): Promise<void> {
    let current: ClaudeSettings = {};
    try {
      current = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')) as ClaudeSettings;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`không đọc được ${claudeSettingsPath}: ${(err as Error).message}`);
        return;
      }
      if (!opts.enabled) return;
    }
    const next = applyHooks(current, opts);
    const before = JSON.stringify(current);
    const after = JSON.stringify(next);
    if (before === after) return;
    await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    log(`hook Claude Code: ${opts.enabled ? 'đã bật' : 'đã tắt'} (${claudeSettingsPath})`);
    if (opts.enabled) {
      void vscode.window.showInformationMessage(
        'NoIdle: đã cài hook cho Claude Code, Copilot Chat và Copilot CLI. Khởi động lại phiên Claude Code/Copilot CLI để nhận hook.',
      );
    }
  }
  // Chuyển setting của bản 1.x (Vi Voice) trước, rồi mới đăng ký hook theo setting đã chuyển.
  void migrateFromViVoice(ctx, log)
    .catch((err) => log(`lỗi chuyển setting cũ: ${(err as Error).message}`))
    .then(() => syncHooks())
    .catch((err) => log(`lỗi đồng bộ hook: ${(err as Error).message}`))
    .then(() => ensureRecapTranslation());

  /** Bật tắt nhanh một cờ boolean của noIdle ở Settings người dùng, rồi báo trạng thái mới. */
  async function flip(key: 'voiceResponse' | 'handsFree', fallback: boolean, on: string, off: string): Promise<void> {
    const c = vscode.workspace.getConfiguration('noIdle');
    const next = !c.get<boolean>(key, fallback);
    await c.update(key, next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`NoIdle: ${next ? on : off}`);
  }
  const toggleMute = () => flip('voiceResponse', true, 'đã bật lại giọng đọc.', 'đã tắt giọng đọc (cửa sổ vẫn nháy, không cần restart).');
  const toggleHandsFree = () => flip('handsFree', false, 'đã bật hands-free, agent xong sẽ mở mic.', 'đã tắt hands-free, mic không tự mở.');

  async function testVoice(): Promise<void> {
    const cfg = config();
    const file = path.join(os.tmpdir(), 'noidle-test-voice.txt');
    // Câu mẫu có đuôi file và chữ viết tắt để nghe được bảng cách đọc (noIdle.pronunciations).
    const lang = uiLang();
    const sample =
      lang === 'en'
        ? 'Hello, this is the NoIdle reader. Done, I updated README.md and called the API, all tests pass.'
        : 'Xin chào, đây là giọng đọc của NoIdle. Xong rồi, đã sửa README.md và gọi API, test pass hết.';
    await fs.promises.writeFile(file, pronounce(sample, cfg.pronunciations, usesVietPronunciation(cfg.voice, lang)), 'utf8');
    const voice = effectiveVoice(cfg.voice, lang);
    // --config để play biết giọng ElevenLabs nếu đang chọn; ghi lại file trước cho chắc.
    await writeHookConfig();
    const args = [hookScript, 'play', file, '--voice', voice, '--rate', cfg.voiceRate, '--player', playerPath(), '--config', hookConfigPath];
    const child = spawn(tools.node, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => void vscode.window.showErrorMessage(`NoIdle: không chạy được node để đọc: ${e.message}`));
    child.unref();
    const label = cfg.ttsProvider === 'elevenlabs' ? `ElevenLabs ${cfg.elevenLabsVoiceId} (${cfg.elevenLabsModel})` : voice;
    void vscode.window.showInformationMessage(`NoIdle: đang đọc thử bằng giọng ${label}. Không nghe thấy gì thì xem log tại ${path.join(os.tmpdir(), 'noidle-tts', 'hook.log')}`);
  }

  /** Bỏ qua bản đang đọc: hook tắt player của vé đầu hàng; bản kế tiếp trong hàng đợi phát tiếp. */
  function skipSpeech(quiet = false): void {
    log(`skip: gọi hook bỏ qua bằng node ${tools.node}`);
    const child = spawn(tools.node, [hookScript, 'skip'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => {
      log(`skip: không chạy được node (${tools.node}): ${e.message}`);
      void vscode.window.showErrorMessage(`NoIdle: không chạy được node để bỏ qua: ${e.message}`);
    });
    child.unref();
    if (!quiet) vscode.window.setStatusBarMessage('NoIdle: đã bỏ qua', 1500);
  }

  let capturingSelection = false;
  async function explainSelected(arg?: unknown): Promise<void> {
    if (!vscode.workspace.getConfiguration('noIdle').get<boolean>('translate', true)) {
      vscode.window.setStatusBarMessage('NoIdle: dịch đang tắt. Bật NoIdle: Translate để dùng Alt+D.', 3000);
      return;
    }
    // Alt+D truyền { source: 'clipboard' } (dịch nội dung đã Ctrl+C). Menu chuột phải editor truyền Uri của file, của terminal không truyền gì.
    const source = arg instanceof vscode.Uri ? 'editor' : arg === undefined ? 'terminal'
      : typeof arg === 'object' && arg !== null && 'source' in arg ? arg.source : undefined;
    if (source !== 'editor' && source !== 'terminal' && source !== 'chat' && source !== 'clipboard') {
      vscode.window.setStatusBarMessage('NoIdle: Ctrl+C để copy chữ rồi bấm Alt+D để dịch.', 3000);
      return;
    }
    if (capturingSelection) return;
    capturingSelection = true;
    let text = '';
    try {
      text = await captureExplainSelection(source, {
        editorSelection: () => {
          const editor = vscode.window.activeTextEditor;
          if (!editor || editor.selection.isEmpty ||
            (arg instanceof vscode.Uri && arg.toString() !== editor.document.uri.toString())) return '';
          return editor.document.getText(editor.selection);
        },
        readClipboard: () => vscode.env.clipboard.readText(),
        writeClipboard: (value) => vscode.env.clipboard.writeText(value),
        copySelection: (target) => vscode.commands.executeCommand(target === 'terminal'
          ? 'workbench.action.terminal.copySelection' : 'editor.action.clipboardCopyAction'),
      });
    } catch (err) {
      log(`lấy vùng chọn lỗi (${source}): ${(err as Error).message}`);
      void vscode.window.showWarningMessage(`NoIdle: không lấy được vùng chọn. ${source === 'terminal'
        ? 'Bôi chữ rồi chọn Giải nghĩa, hoặc Ctrl+C rồi bấm Alt+D.' : 'Bôi chữ rồi Ctrl+C, sau đó bấm Alt+D.'}`);
      return;
    } finally {
      capturingSelection = false;
    }
    if (!text.trim()) {
      const msg = source === 'terminal'
        ? 'NoIdle: chưa có vùng chọn terminal. Bôi chữ rồi chọn Giải nghĩa, hoặc Ctrl+C rồi bấm Alt+D.'
        : source === 'editor'
          ? 'NoIdle: chưa bôi chữ nào để dịch. Bôi chữ rồi bấm Alt+D.'
          : 'NoIdle: clipboard trống. Bôi chữ rồi Ctrl+C, sau đó bấm Alt+D.';
      vscode.window.setStatusBarMessage(msg, 4000);
      return;
    }
    await explainAndShow(text);
  }

  /** Giải nghĩa rồi hiện thông báo góc màn hình (nút Copy). */
  const explaining = new Set<string>();
  async function explainAndShow(text: string): Promise<void> {
    if (explaining.has(text)) return;
    explaining.add(text);
    try {
      await showExplanation(text);
    } finally {
      explaining.delete(text);
    }
  }

  /**
   * Dịch nhanh: ưu tiên model Copilot trong tiến trình (vscode.lm) để KHỎI khởi động lại CLI (mỗi lần spawn mất nhiều
   * giây); không có model thì mới spawn Claude/Copilot CLI. Cache theo nội dung để từ đã dịch trả về tức thì.
   */
  const explainCache = new Map<string, string>();
  function rememberExplain(key: string, value: string): void {
    explainCache.set(key, value);
    if (explainCache.size > 300) {
      const oldest = explainCache.keys().next().value;
      if (oldest !== undefined) explainCache.delete(oldest);
    }
  }
  async function explainViaLm(prompt: string): Promise<string | undefined> {
    // Ưu tiên model nhỏ nhanh, ít tốn quota cho việc dịch / giải nghĩa ngắn. Chọn model có tên gợi ý "nhẹ" bất kể hãng:
    // Claude -> haiku, OpenAI -> mini/nano, Gemini -> flash/lite. Không có cái nào thì mới dùng model Copilot đầu tiên
    // (tránh rơi vào model lớn như Sonnet / GPT-4o vốn phản hồi chậm hơn).
    const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!all.length) return undefined;
    const small = /mini|flash|haiku|lite|nano|small/i;
    const model = all.find((m) => small.test(m.family) || small.test(m.id) || small.test(m.name)) ?? all[0];
    if (!model) return undefined;
    const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, new vscode.CancellationTokenSource().token);
    let out = '';
    for await (const chunk of res.text) out += chunk;
    return out.trim() || undefined;
  }
  async function explainText(text: string): Promise<ExplainResult> {
    const key = text.trim();
    if (!key) return { ok: false, reason: 'empty' };
    const hit = explainCache.get(key);
    if (hit) return { ok: true, text: hit };
    try {
      const lm = await explainViaLm(explainPrompt(key));
      if (lm) {
        rememberExplain(key, lm);
        return { ok: true, text: lm };
      }
    } catch (err) {
      log(`vscode.lm giải nghĩa lỗi, chuyển sang CLI: ${(err as Error).message}`);
    }
    const r = await explainSelection(key);
    if (r.ok) rememberExplain(key, r.text);
    return r;
  }

  async function showExplanation(text: string): Promise<void> {
    const short = text.trim().replace(/\s+/g, ' ');
    const label = short.length > 40 ? `${short.slice(0, 40)}…` : short;
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `NoIdle: đang giải nghĩa "${label}"` },
      () => explainText(text),
    );
    if (!r.ok) {
      log(`giải nghĩa lỗi: ${r.reason}`);
      void vscode.window.showWarningMessage(r.reason === 'no-cli'
        ? 'NoIdle: không dùng được Copilot Chat lẫn Claude/Copilot CLI để giải nghĩa.'
        : `NoIdle: giải nghĩa lỗi: ${r.reason}`);
      return;
    }
    const pick = await vscode.window.showInformationMessage(`${label}: ${r.text}`, 'Copy');
    if (pick === 'Copy') {
      await vscode.env.clipboard.writeText(r.text);
    }
  }

  async function restoreCopyOnSelection(): Promise<void> {
    if (!ctx.globalState.get<boolean>('noIdle.setCopyOnSelection')) return;
    const term = vscode.workspace.getConfiguration('terminal.integrated');
    // Chỉ gỡ giá trị true mà bản cũ đã tự bật; không ghi đè lựa chọn false mới của người dùng.
    if (term.inspect<boolean>('copyOnSelection')?.globalValue === true) {
      await term.update('copyOnSelection', undefined, vscode.ConfigurationTarget.Global);
    }
    await ctx.globalState.update('noIdle.setCopyOnSelection', undefined);
    log('dịch: đã gỡ tự copy vùng chọn do NoIdle cũ bật');
  }
  void restoreCopyOnSelection().catch((err) => log(`trả setting tự copy lỗi: ${(err as Error).message}`));

  /** Lỗi sửa câu: ghi log mỗi lần, và cảnh báo một lần khi model không tồn tại (Groq gỡ model mà không ai biết, chữ thô cứ thế hiện ra). */
  let warnedRefineModel = false;
  function reportRefineError(message: string): void {
    log(`refine: ${message}`);
    if (!message.includes('không tồn tại') || warnedRefineModel) return;
    warnedRefineModel = true;
    void vscode.window
      .showWarningMessage(`NoIdle: ${message}.`, 'Mở setting refineModel')
      .then((pick) => pick && vscode.commands.executeCommand('workbench.action.openSettings', 'noIdle.refineModel'));
  }

  /** Gửi một cụm lên Groq và chèn kết quả. Trả về text đã chèn ('' nếu không có). */
  async function deliverSegment(
    wav: Uint8Array,
    target: Target,
    context: string,
    s?: Session,
    terminal?: vscode.Terminal,
    editor?: vscode.TextEditor,
  ): Promise<string> {
    const apiKey = await resolveApiKey();
    if (!apiKey) return '';
    let text: string;
    const cfg = config();
    const t0 = Date.now();
    // Ngôn ngữ Whisper nghe được, chỉ áp dụng khi cụm này còn chữ sau lọc: câu bịa "Thank you" trên tiếng ồn từng
    // chuyển cả phiên sang tiếng Anh.
    let whisperLang: string | undefined;
    try {
      text = await transcribe(wav, {
        apiKey,
        glossary: cfg.glossary,
        language: cfg.language,
        promptLang: uiLang(),
        onRaw: (raw) => log(`whisper thô: ${JSON.stringify(raw)}`),
        onLanguage: (l) => (whisperLang = l),
      });
    } catch (err) {
      log(`lỗi: ${(err as Error).message}`);
      failed = { wav, target, context, terminal: terminal ?? s?.terminal, editor: editor ?? s?.editor };
      if (err instanceof TranscribeError && err.kind === 'auth') {
        const pick = await vscode.window.showErrorMessage(`NoIdle: ${err.message}`, 'Nhập lại key');
        if (pick) await setApiKey();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const pick = await vscode.window.showErrorMessage(`NoIdle: ${message}`, 'Gửi lại');
        if (pick) void vscode.commands.executeCommand('noIdle.retry');
      }
      return '';
    }
    log(`sau lọc (${Date.now() - t0}ms): ${JSON.stringify(text)}`);
    if (!text) return '';
    if (cfg.auto && whisperLang) {
      const next = langOf(whisperLang);
      if (next !== heardLang) log(`auto: Whisper nghe ${whisperLang}, chuyển sang ${next}`);
      heardLang = next;
    }
    if (s?.auto) {
      // Lệnh nói xét trên chữ thô, trước khi LLM có thể sửa mất từ "gửi".
      const cmd = parseVoiceCommand(text);
      if (cmd.command === 'cancel') {
        log('hands-free: nghe lệnh huỷ');
        void finishAuto(s, false);
        return '';
      }
      if (cmd.command === 'send') {
        log('hands-free: nghe lệnh gửi');
        s.sendNow = true;
        text = cmd.text;
        if (!text) return '';
      }
    }
    if (cfg.refine) {
      const t1 = Date.now();
      text = await refine(text, { apiKey, target, context, model: cfg.refineModel, glossary: cfg.glossary, language: uiLang(), onError: reportRefineError });
      log(`sau LLM (${Date.now() - t1}ms): ${JSON.stringify(text)}`);
    }
    if (!text) return '';
    // Hands-free: tiếng ồn làm Whisper bịa cùng một câu ngắn cho mỗi cụm ("Thank you" ba lần); từng câu qua được bộ lọc
    // nhưng cộng dồn đủ từ để tự gửi. Cụm ngắn lặp đúng đuôi chữ đã gõ thì bỏ.
    if (s?.auto && repeatsTail(context, text)) {
      log(`hands-free: bỏ cụm lặp ${JSON.stringify(text)}`);
      return '';
    }
    const piece = (context ? ' ' : '') + text;
    // Editor và ô chat không đi qua lệnh type (vào chỗ đang focus): editor chèn qua editor.edit của editor đã chốt,
    // chat đặt lại toàn bộ transcript vào ô chat bằng lệnh mở chat, nên đổi focus giữa chừng chữ vẫn vào đúng chỗ.
    const pinnedEditor = editor ?? s?.editor;
    const used = await inject(target, piece, api, {
      typeDelayMs: config().typeDelayMs,
      terminal: terminal ?? s?.terminal,
      editor: pinnedEditor && { insert: (t) => pinnedEditor.edit((eb) => eb.insert(pinnedEditor.selection.active, t)) },
      chatText: target === 'chat' ? context + piece : undefined,
    });
    if (used === 'clipboard') {
      void vscode.window.showInformationMessage(`NoIdle: đã copy vào clipboard: "${text}"`);
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
    // Không reset đồng hồ im lặng ở đây: tiếng gõ phím hay quạt cũng thành cụm âm thanh, mà reset theo cụm thì mic
    // mở mãi tới 2 phút. Chỉ chữ thật (sau lọc) mới reset, xem dưới.
    if (s.auto) clearTimeout(s.sendTimer); // có cụm mới thì chưa gửi
    s.segments++;
    const wav = pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
    log(`cụm ${s.segments} (${(Recorder.durationMs(wav) / 1000).toFixed(1)}s) → ${s.target}`);
    s.queue = s.queue
      .then(async () => {
        const piece = await deliverSegment(wav, s.target, s.transcript, s);
        s.delivered++;
        if (piece) {
          s.transcript += piece;
          s.lastTextAt = Date.now();
          if (s.auto) armIdle(s);
        }
        if (s.auto && !s.finishing) {
          if (s.sendNow) void finishAuto(s, true);
          else armSend(s);
        }
      })
      .catch(() => undefined);
  }

  /** Hands-free: cụm cuối chèn xong, im lặng thêm handsFreeSendDelaySec và đã đủ từ thì tự gửi. */
  function armSend(s: Session): void {
    clearTimeout(s.sendTimer);
    const cfg = config();
    if (!cfg.handsFreeAutoSend) return;
    const delayMs = Math.max(0.5, cfg.handsFreeSendDelaySec) * 1000;
    s.sendTimer = setTimeout(() => {
      if (session !== s) return;
      // Đồng hồ tính từ lúc chèn chữ xong, nhưng người dùng có thể đang nói dở cụm kế: chờ đủ im lặng kể từ tiếng cuối.
      // Có cụm chưa qua Whisper thì luôn chờ. Còn nếu VAD cứ thấy "tiếng" mà lâu rồi không ra chữ nào thì đó là tiếng ồn
      // (gõ phím, quạt), không chờ mãi: quá NOISE_GRACE_MS kể từ chữ cuối là gửi.
      const sinceSpeech = Date.now() - s.lastSpeechAt;
      const pending = s.segments - s.delivered;
      const sinceText = Date.now() - s.lastTextAt;
      if (pending > 0 || (sinceSpeech < delayMs && sinceText < NOISE_GRACE_MS)) {
        log(`hands-free: ${pending ? `${pending} cụm đang chờ Whisper` : `vẫn có tiếng (${sinceSpeech}ms trước)`}, chờ thêm`);
        armSend(s);
        return;
      }
      if (sinceSpeech < delayMs) log(`hands-free: vẫn có tiếng nhưng ${Math.round(sinceText / 1000)}s không ra chữ, coi là ồn`);
      const words = countWords(s.transcript);
      if (words < AUTO_SEND_MIN_WORDS) {
        log(`hands-free: mới ${words} từ, chưa tự gửi`);
        return;
      }
      void finishAuto(s, true);
    }, delayMs);
  }

  function countWords(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  /** Kết thúc session hands-free: tắt mic, chờ chữ chèn xong, rồi gửi Enter vào terminal nếu send. */
  async function finishAuto(s: Session, send: boolean): Promise<void> {
    if (session !== s || s.finishing) return;
    s.finishing = true;
    clearTimeout(s.sendTimer);
    await toggle();
    if (session === s) {
      // toggle đang bận nên chưa tắt được; không gửi khi mic còn mở.
      s.finishing = false;
      return;
    }
    await lastQueue;
    if (!send) {
      log('hands-free: tắt mic, không gửi');
      return;
    }
    if (!countWords(s.transcript)) {
      log('hands-free: không có chữ, không gửi');
      return;
    }
    if (s.target === 'chat') {
      // Copilot Chat: mở chat với toàn bộ transcript, không có isPartialQuery thì VS Code gửi luôn; không phụ thuộc focus.
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: s.transcript });
      log(`hands-free: đã gửi chat (${countWords(s.transcript)} từ)`);
      return;
    }
    // Enter vào đúng terminal đã chốt lúc mở mic, không phải terminal đang focus lúc này.
    if (!s.terminal || s.terminal.exitStatus) {
      log('hands-free: terminal của phiên đã đóng, không gửi Enter');
      return;
    }
    s.terminal.sendText('', true);
    log(`hands-free: đã gửi Enter (${countWords(s.transcript)} từ)`);
  }

  async function toggle(args?: { target?: Target; auto?: boolean; terminal?: vscode.Terminal }): Promise<void> {
    if (busy || asking) return;
    busy = true;
    try {
      if (!session) {
        if (!(await getApiKey())) return;
        // Lượt nói mới: nếu lượt trước bị Groq 429 thì thử sửa câu lại ngay, hạn mức có thể đã được nới.
        resetRefinePause();
        const target = args?.target ?? 'clipboard';
        // Hands-free (auto) nhường mic nếu cửa sổ VS Code khác đang nghe; F6 tay thì người dùng đã chọn cửa sổ này:
        // bảo cửa sổ kia tắt mic rồi lấy khoá về mình.
        const holder = micHolder();
        if (holder !== undefined && holder !== process.pid) {
          if (args?.auto) {
            log(`mic: cửa sổ khác (pid ${holder}) đang nghe, không mở hands-free`);
            return;
          }
          // Bảo cửa sổ kia tắt mic (F6, hands-free hay đang nghe approve) rồi chờ nó trả khoá; chỉ khi nó chết mới lấy ép.
          const told = await signalPid(holder, { event: 'submitted', session: '', cwd: '' });
          const t0 = Date.now();
          while (micHolder() === holder && Date.now() - t0 < MIC_HANDOVER_MS) await new Promise((r) => setTimeout(r, 100));
          const freed = micHolder() !== holder;
          log(`mic: F6 xin mic từ cửa sổ pid ${holder}: ${told ? 'đã báo' : 'không liên lạc được'}, ${freed ? 'đã trả' : 'chưa trả'} sau ${Date.now() - t0}ms`);
          if (!freed) {
            vscode.window.setStatusBarMessage('NoIdle: cửa sổ khác đang nghe, thử lại sau', 3000);
            return;
          }
        }
        if (!acquireMic(process.pid)) {
          log(`mic: cửa sổ khác (pid ${micHolder()}) vừa lấy mic trước, không mở`);
          return;
        }
        // F6 lúc loa đang đọc: cắt lượt đọc để mic không thu tiếng loa; các lượt đọc sau tự chờ khoá mic.
        // Hands-free và nghe approve thì hook đã đọc xong mới ra hiệu, không cần cắt.
        if (!args?.auto) skipSpeech(true);
        const s: Session = {
          target,
          segmenter: undefined as unknown as Segmenter,
          queue: lastQueue,
          transcript: '',
          segments: 0,
          auto: !!args?.auto,
          // Hands-free đưa sẵn terminal đang chạy Claude (tìm theo cây tiến trình); F6 tay thì lấy terminal đang chọn.
          terminal: target === 'terminal' ? (args?.terminal ?? vscode.window.activeTerminal) : undefined,
          editor: target === 'editor' ? vscode.window.activeTextEditor : undefined,
          lastSpeechAt: Date.now(),
          lastTextAt: Date.now(),
          delivered: 0,
        };
        s.segmenter = new Segmenter({ sampleRate: SAMPLE_RATE, onSpeech: () => (s.lastSpeechAt = Date.now()) }, (pcm) => enqueue(s, pcm));
        // Hands-free: mở mic xong mới bíp (như nghe approve, xem listen.ts); bíp trước là mấy chữ đầu rơi vào lúc
        // ffmpeg còn đang mở. Audio lúc bíp và ASK_GUARD_MS sau đó bị bỏ để không thu tiếng loa.
        let live = !s.auto;
        try {
          await recorder.start((chunk) => {
            if (live) s.segmenter.push(chunk);
          });
        } catch (err) {
          releaseMic(process.pid);
          throw err;
        }
        if (s.auto) {
          await beep();
          setTimeout(() => (live = true), ASK_GUARD_MS);
          s.lastSpeechAt = s.lastTextAt = Date.now();
        }
        session = s;
        status.set(s.auto ? 'listening' : 'recording', uiLang(), agentLabel);
        maxTimer = setTimeout(() => void vscode.commands.executeCommand('noIdle.toggle'), MAX_RECORD_MS);
        if (s.auto) armIdle(s);
        return;
      }
      clearTimeout(maxTimer);
      const s = session;
      clearTimeout(s.idleTimer);
      clearTimeout(s.sendTimer);
      session = undefined;
      const audio = await recorder.stop();
      releaseMic(process.pid);
      lastAudio = audio;
      s.segmenter.flush();
      status.set('transcribing');
      // Cảnh báo mic chỉ cho F6 bấm tay: hands-free hết giờ im lặng là chuyện thường, không phải mic hỏng.
      if (!s.auto && s.segments === 0 && Recorder.durationMs(audio) >= MIN_RECORD_MS) {
        const level = audioLevel(audio);
        void vscode.window.showWarningMessage(
          `NoIdle: không nghe thấy tiếng nói (peak ${level.peakDb.toFixed(0)} dB, rms ${level.rmsDb.toFixed(0)} dB). ` +
            (process.platform === 'darwin'
              ? 'Kiểm tra mic trong System Settings > Sound > Input và quyền mic ở Privacy & Security > Microphone, hoặc chạy lệnh "NoIdle: Chọn micro".'
              : 'Kiểm tra mic trong Windows Settings > Sound > Input, hoặc chạy lệnh "NoIdle: Chọn micro".'),
        );
      }
      // Không chờ các cụm cuối gửi xong: người dùng có thể bấm F6 nói tiếp ngay.
      lastQueue = s.queue.then(() => {
        if (!session) status.set('idle');
      });
    } catch (err) {
      session = undefined;
      status.set('idle');
      void vscode.window.showErrorMessage(`NoIdle: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }

  async function retry(): Promise<void> {
    if (!failed) {
      void vscode.window.showInformationMessage('NoIdle: không có cụm nào cần gửi lại');
      return;
    }
    const f = failed;
    failed = undefined;
    status.set('transcribing');
    try {
      await deliverSegment(f.wav, f.target, f.context, undefined, f.terminal, f.editor);
    } finally {
      status.set('idle');
    }
  }

  async function pickMic(): Promise<void> {
    try {
      const devices = await listAudioDevices(tools.ffmpeg);
      if (devices.length === 0) {
        void vscode.window.showWarningMessage('NoIdle: ffmpeg không thấy micro nào');
        return;
      }
      const pick = await vscode.window.showQuickPick(devices, { placeHolder: 'Chọn micro cho NoIdle' });
      if (pick) {
        await vscode.workspace.getConfiguration('noIdle').update('micDevice', pick, vscode.ConfigurationTarget.Global);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`NoIdle: ${(err as Error).message}`);
    }
  }

  async function saveLastAudio(): Promise<void> {
    if (!lastAudio) {
      void vscode.window.showInformationMessage('NoIdle: chưa có audio nào');
      return;
    }
    const file = path.join(os.tmpdir(), 'noidle-last.wav');
    await fs.promises.writeFile(file, lastAudio);
    const level = audioLevel(lastAudio);
    void vscode.window.showInformationMessage(
      `NoIdle: đã lưu ${file} (${(Recorder.durationMs(lastAudio) / 1000).toFixed(1)}s, peak ${level.peakDb.toFixed(0)} dB)`,
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

  /**
   * Nghe một câu cho hook (approve, chọn đáp án): mở mic, bíp, lấy cụm tiếng nói đầu tiên, gửi Whisper (không qua LLM).
   * Trả '' nếu mic đang bận, không ai nói trong timeoutMs, hoặc lỗi; hook sẽ để hộp thoại hiện như thường.
   */
  async function askOnce(timeoutMs: number, reason: Signal['reason']): Promise<string> {
    const allowed = () => canAutoListen({ event: 'ask', reason }, config());
    if (!allowed()) {
      log('ask: setting hiện tại không cho phép mở mic, bỏ qua');
      return '';
    }
    if (session || asking) {
      log('ask: mic đang bận, bỏ qua');
      return '';
    }
    const apiKey = await resolveApiKey();
    if (!apiKey || !allowed() || session || asking) return '';
    // Cửa sổ khác đang nghe (F6 hay hands-free): không mở mic thứ hai, để hộp thoại hiện cho bấm tay.
    if (!acquireMic(process.pid)) {
      log(`ask: cửa sổ khác (pid ${micHolder()}) đang giữ mic, bỏ qua`);
      return '';
    }
    asking = true;
    askingReason = reason;
    status.set('listening', uiLang(), agentLabel);
    // Câu báo "cần approve" đã đọc xong và trả vé hàng đợi trước khi hook gửi ask; trong khe đó một câu của phiên khác
    // có thể vừa bắt đầu phát và mic sẽ thu tiếng loa. Cắt như F6; các câu xếp sau tự chờ khoá mic.
    skipSpeech(true);
    try {
      const t0 = Date.now();
      resetRefinePause();
      // Mở mic và chờ dữ liệu chảy RỒI mới bíp (listenOnce): ffmpeg lạnh mất vài giây, bíp trước là người dùng
      // nói "approve" vào lúc mic chưa thu. Audio lúc bíp và ASK_GUARD_MS sau đó bị bỏ để không thu tiếng loa.
      const pcm = await listenOnce({
        start: (onData) => recorder.start(onData),
        beep,
        // minSpeechMs thấp để một tiếng "một" hay "ok" ngắn cũng được nhận; ngắt hơi 1.2s là xong câu.
        segmenter: (onSegment) =>
          new Segmenter({ sampleRate: SAMPLE_RATE, silenceMs: 1200, maxSegmentMs: timeoutMs, minSpeechMs: 180 }, onSegment),
        onCancel: (cancel) => {
          cancelAsk = () => {
            log('ask: bị huỷ');
            cancel();
          };
        },
        timeoutMs,
        guardMs: ASK_GUARD_MS,
        log,
      });
      cancelAsk = undefined;
      // Bị huỷ lúc mic còn đang khởi động thì listenOnce vẫn chờ start xong mới trả, nên đến đây stop() là dừng thật.
      if (recorder.recording) await recorder.stop();
      if (!allowed()) return '';
      if (!pcm) {
        log(`ask: không nghe thấy gì sau ${Date.now() - t0}ms`);
        return '';
      }
      const wav = pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
      status.set('transcribing');
      const cfg = config();
      const heard = await transcribe(wav, { apiKey, glossary: cfg.glossary, language: cfg.language, promptLang: uiLang() });
      if (!allowed()) return '';
      log(`ask: nghe ${JSON.stringify(heard)} (${Date.now() - t0}ms)`);
      return heard;
    } catch (err) {
      log(`ask lỗi: ${(err as Error).message}`);
      return '';
    } finally {
      asking = false;
      askingReason = undefined;
      releaseMic(process.pid);
      status.set('idle');
    }
  }

  /**
   * Tín hiệu từ hook Claude Code: listen = Claude vừa đọc xong, mở mic; submitted = người dùng đã gửi, tắt mic;
   * ask = nghe một câu và trả chữ về cho hook.
   */
  /**
   * Copilot Chat sắp chạy lệnh terminal mà setting auto-approve không tự duyệt. Hook không ép hộp thoại (VS Code sẽ ẩn
   * menu Allow); extension chờ bằng chứng tool đã chạy, hết giờ mới đọc câu báo và nháy cửa sổ.
   */
  const chatPending = new ChatPendingTracker({
    log,
    onAnnounce: (p) => {
      const cfg = config();
      if (cfg.voiceResponse && cfg.voiceNotify !== false) speakNotify(p);
      else log('chat pending: giọng đọc tắt, chỉ nháy cửa sổ');
      void onAttention('approve').catch((err) => log(`chat pending: lỗi nháy cửa sổ: ${(err as Error).message}`));
    },
  });
  ctx.subscriptions.push(
    { dispose: () => chatPending.clear() },
    vscode.window.onDidOpenTerminal((t) => chatPending.terminalOpened(isAgentTerminal(t.creationOptions as { env?: Record<string, string | null | undefined> | null }))),
    vscode.window.onDidStartTerminalShellExecution((e) =>
      chatPending.executionStarted(e.execution.commandLine.value, isAgentTerminal(e.terminal.creationOptions as { env?: Record<string, string | null | undefined> | null }))),
  );

  /** Đọc câu báo approve của Chat qua tiến trình play của hook (cùng hàng đợi, khoá mic và giọng ElevenLabs). */
  function speakNotify(p: PendingChatTool & { lang?: Lang }): void {
    const cfg = config();
    const lang: Lang = p.lang ?? langOf(cfg.language);
    const voice = effectiveVoice(cfg.voice, lang);
    const file = path.join(os.tmpdir(), 'noidle-tts', `say-chat-${Date.now()}-${process.pid}.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pronounce(p.text, cfg.pronunciations, usesVietPronunciation(voice, lang)), 'utf8');
    const args = [hookScript, 'play', file, '--voice', voice, '--rate', cfg.voiceRate, '--player', playerPath(), '--config', hookConfigPath,
      '--kind', 'notify', '--session', p.session || '-'];
    const child = spawn(tools.node, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log(`chat pending: không chạy được node để đọc: ${e.message}`));
    child.unref();
  }

  async function onSignal(s: Signal): Promise<string | void> {
    if (s.event === 'probe') {
      // Hook hỏi mọi cửa sổ trước khi gửi: extension host này (Copilot Chat) hay một terminal của cửa sổ này
      // (Claude Code, Copilot CLI) nằm trong chuỗi pid thì mới là cửa sổ chứa agent. Chỉ trả lời, không xử lý.
      return (await agentInWindow(s.ancestors, process.pid, vscode.window.terminals)) ? 'owned' : 'no';
    }
    if (s.event === 'peerAttention') {
      if (!vscode.window.state.focused || !s.text || !s.reason) return;
      log(`cửa sổ "${s.text}" cần người dùng (${s.reason}), hiện trên status bar`);
      showPeerNotice(peerNotice(s.text, s.reason, s.source === 'claude' || !s.source ? 'Claude' : 'Copilot'), s.cwd);
      return;
    }
    log(`tín hiệu ${s.event} (session ${s.session || '-'})`);
    if (s.source) agentLabel = s.source === 'claude' ? 'Claude' : 'Copilot';
    if (s.event === 'chatPending') {
      if (!s.text || !s.command) return;
      chatPending.add({ session: s.session, toolUseId: s.toolUseId, command: s.command, text: s.text, ...(s.lang ? { lang: s.lang } : {}) } as PendingChatTool);
      return;
    }
    if (s.event === 'chatDone') {
      chatPending.done({ toolUseId: s.toolUseId, session: s.session, command: s.command });
      return;
    }
    if (s.event === 'submitted') chatPending.promptSubmitted(s.session);
    if (s.event === 'attention') {
      // Hook mới đã chọn cửa sổ bằng probe. Hook cũ (chưa reload) gửi cho mọi cửa sổ kèm chuỗi pid: vẫn tự kiểm tra.
      if (s.ancestors?.length && !(await agentInWindow(s.ancestors, process.pid, vscode.window.terminals))) {
        log(`attention ${s.reason ?? 'done'}: agent không ở cửa sổ này, bỏ qua`);
        return;
      }
      return onAttention(s.reason ?? 'done', s.startedAt);
    }
    if (s.event === 'ask') return askOnce(Math.max(3, s.timeoutSec ?? 15) * 1000, s.reason);
    if (s.event === 'resumed') {
      // Việc nền xong, Claude chạy tiếp: không còn "done". Mic đang mở thì để nguyên (câu đang nói vẫn vào hàng đợi).
      clearAttention();
      return;
    }
    if (s.event === 'submitted') {
      // Người dùng đã quay lại cửa sổ này và gửi tiếp: không cần làm nổi nữa.
      clearAttention();
      // Người dùng vừa gửi prompt (tự gõ Enter sau khi F6, hoặc hands-free): mic nào đang mở cũng tắt,
      // không thì lát nữa nó nghe luôn giọng Claude đọc câu trả lời rồi chèn vào terminal.
      if (session) {
        log(`submitted: tắt mic ${session.auto ? 'hands-free' : 'F6'} đang mở`);
        await toggle();
      }
      if (cancelAsk) {
        log('submitted: huỷ lượt nghe approve đang chạy');
        cancelAsk();
        // Chờ recorder dừng và khoá mic được trả (askOnce trả khoá ở finally) trước khi báo xong cho bên gọi.
        const t0 = Date.now();
        while (asking && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 50));
      }
      return;
    }
    if (!canAutoListen(s, config())) return;
    if (session || asking) {
      log('hands-free: mic đang bật sẵn, bỏ qua');
      return;
    }
    if (s.source === 'copilot') {
      // Copilot Chat vừa đọc xong: câu tiếp theo vào ô chat, không phải terminal. Mở và focus ô chat trước khi gõ.
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
      } catch (err) {
        log(`hands-free: không mở được ô chat Copilot: ${(err as Error).message}`);
        return;
      }
      await toggle({ target: 'chat', auto: true });
      return;
    }
    // Hook gửi kèm chuỗi pid tổ tiên của Claude Code; terminal nào có shell pid trong chuỗi là terminal đang chạy Claude,
    // không phụ thuộc terminal nào đang được chọn hay cửa sổ nào đang focus. Chỉ lấy terminal đang chọn khi hook
    // không tra được cây tiến trình; tra được mà không khớp là agent chạy ngoài VS Code, không mở mic.
    const terminal = await terminalForAgent(vscode.window.terminals, s.ancestors, vscode.window.activeTerminal, s.source);
    if (!terminal) {
      const agent = s.source === 'copilot-cli' ? 'Copilot CLI' : 'Claude Code';
      log(s.source === 'copilot-cli' || s.ancestors?.length
        ? `hands-free: không tìm thấy terminal VS Code của ${agent}, không mở mic để tránh gõ nhầm shell`
        : 'hands-free: không có terminal đang mở, bỏ qua');
      return;
    }
    log(`hands-free: ${s.source === 'copilot-cli' ? 'Copilot CLI' : 'Claude Code'} → terminal "${terminal.name}"`);
    await toggle({ target: 'terminal', auto: true, terminal });
  }

  /**
   * Cửa sổ này có việc cần người dùng. Đang focus thì không cần gì; không thì đổi màu status bar (tự tắt khi
   * cửa sổ được focus) và nháy nút trên taskbar Windows (macOS: nháy title bar) để tìm ra giữa nhiều cửa sổ.
   */
  /** Giá trị cũ của các khoá title bar đã ghi đè trong colorCustomizations của workspace; undefined = chưa tô. */
  let tintSaved: ColorMap | undefined;
  const colorCfg = () => vscode.workspace.getConfiguration('workbench');
  const workspaceColors = () => colorCfg().inspect<ColorMap>('colorCustomizations')?.workspaceValue;
  const shellColor = () => {
    const k = vscode.window.activeColorTheme.kind;
    return shellColorFor(k === vscode.ColorThemeKind.Light ? 'light' : k === vscode.ColorThemeKind.HighContrast ? 'hcDark' : k === vscode.ColorThemeKind.HighContrastLight ? 'hcLight' : 'dark');
  };

  /** Màu đã dùng lúc tô, để gỡ đúng màu đó dù người dùng đổi setting giữa chừng. */
  let tintBg = TINT.activeBackground;

  /** Khoá workspaceState nhớ màu đã tô (bền qua tắt máy, theo từng workspace) để lần khởi động sau gỡ chắc chắn. */
  const TINT_STATE = 'noidle.tintBg';

  async function tintTitleBar(): Promise<void> {
    if (tintSaved || !vscode.workspace.workspaceFolders?.length) return;
    tintBg = config().attentionTintColor;
    const { next, saved } = applyTint(workspaceColors(), shellColor(), tintBg);
    tintSaved = saved;
    try {
      // Nhớ trước khi ghi màu: tắt máy giữa chừng thì lần sau vẫn biết màu nào là của mình.
      await ctx.workspaceState.update(TINT_STATE, tintBg);
      await colorCfg().update('colorCustomizations', next, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      tintSaved = undefined;
      log(`attention: không tô được title bar: ${(err as Error).message}`);
    }
  }

  /** why: ghi log vì sao gỡ (focus, khởi động, thử lại...). Không có gì để gỡ thì im, trừ khi còn nhớ màu cũ. */
  async function untintTitleBar(why = 'focus'): Promise<void> {
    const current = workspaceColors();
    let saved: ColorMap = {};
    let bg: string;
    let next: ColorMap | undefined;
    if (tintSaved) {
      saved = tintSaved;
      bg = tintBg;
      next = removeTint(current, saved, shellColor(), bg);
    } else {
      // Extension vừa khởi động lại: màu của mình còn trong file (đã nhớ, hoặc bằng màu setting với bản cũ) thì gỡ.
      const remembered = ctx.workspaceState.get<string>(TINT_STATE);
      const plan = staleTintPlan({ current, remembered, configured: config().attentionTintColor, shell: shellColor() });
      if (!plan) {
        if (remembered) {
          log(`attention: còn nhớ màu ${remembered} đã tô nhưng settings không có, chỉ xoá dấu nhớ (${why})`);
          await ctx.workspaceState.update(TINT_STATE, undefined);
        }
        return;
      }
      ({ bg, next } = plan);
      log(`attention: settings còn màu ${bg} từ lần trước, gỡ (${why})`);
    }
    tintSaved = undefined;
    try {
      await colorCfg().update('colorCustomizations', next, vscode.ConfigurationTarget.Workspace);
      await ctx.workspaceState.update(TINT_STATE, undefined);
    } catch (err) {
      log(`attention: không gỡ được màu title bar (${why}): ${(err as Error).message}`);
    }
  }
  /** Tăng mỗi lần bắt đầu hoặc huỷ nháy title bar (macOS), để lượt nháy cũ tự dừng. */
  let blinkRun = 0;
  const clearAttention = () => {
    blinkRun++;
    status.clearAttention();
    void untintTitleBar();
  };
  // Cửa sổ trước đóng lúc đang tô thì màu còn nằm trong settings của workspace: gỡ khi khởi động và khi tắt extension.
  // Lúc mới bật máy nhiều cửa sổ cùng khởi động, cấu hình workspace có thể chưa nạp xong: thử lại sau 3 và 15 giây,
  // và khi workspace được cấp trust (Restricted Mode không cho ghi settings workspace).
  void untintTitleBar('khởi động');
  for (const ms of [3000, 15000]) {
    const t = setTimeout(() => void untintTitleBar(`thử lại sau ${ms / 1000}s`), ms);
    ctx.subscriptions.push({ dispose: () => clearTimeout(t) });
  }
  ctx.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => void untintTitleBar('workspace được trust')),
    { dispose: () => void untintTitleBar('tắt extension') },
  );

  /** Lần cửa sổ mất focus gần nhất (ms); 0 nếu chưa từng focus từ khi extension chạy. */
  let lastBlurAt = 0;
  let prevFocused = vscode.window.state.focused;
  /** Cửa sổ đang mở tab nào không: không thì tiêu đề không có đoạn tên file, đoạn đầu là workspace. */
  const hasEditor = () => vscode.window.tabGroups.all.some((g) => g.tabs.length > 0);

  async function onAttention(reason: AttentionReason, startedAt?: number): Promise<void> {
    const cfg = config();
    // Tín hiệu tới muộn (hook chậm) mà người dùng đã quay lại xem cửa sổ sau lúc agent xong rồi đi: không nháy nữa.
    if (!shouldFlash({ focused: vscode.window.state.focused, lastBlurAt, startedAt })) {
      log(`attention ${reason}: ${vscode.window.state.focused ? 'cửa sổ đang focus' : 'người dùng đã xem cửa sổ sau khi agent xong'}, bỏ qua`);
      return;
    }
    if (cfg.attentionColor) {
      status.attention(reason, langOf(cfg.language), agentLabel);
      await tintTitleBar();
    }
    tellPeers(reason);
    if (cfg.attentionFlash && process.platform === 'darwin') {
      // macOS: không có taskbar, nháy title bar thay thế; attentionColor bật thì nháy xong giữ màu.
      const my = ++blinkRun;
      const r = await blinkTitleBar(
        {
          on: tintTitleBar,
          off: untintTitleBar,
          wait: (ms) => new Promise((res) => setTimeout(res, ms)),
          cancelled: () => my !== blinkRun || vscode.window.state.focused,
        },
        cfg.attentionColor,
      );
      log(`attention ${reason}: nháy title bar → ${r}`);
    } else if (cfg.attentionFlash) {
      const name = wsName();
      if (!name && !myHwnd) return;
      const used = myHwnd;
      const r = await flashWindowEx(name, { hwnd: myHwnd, hasEditor: hasEditor() });
      log(`attention ${reason}: nháy taskbar ${used ? `hwnd ${used}` : `"${name}"`} → ${r.result}${r.staleHandle ? ' (handle không còn đúng, đã tìm theo tên; sẽ học lại)' : ''}`);
      if (r.staleHandle && myHwnd === used) myHwnd = undefined;
    }
  }

  /**
   * Dòng báo cửa sổ khác cần người dùng; bấm vào thì nhảy sang cửa sổ đó: chạy CLI của chính VS Code này với đúng folder
   * hay file workspace của nó, VS Code thấy đã mở thì focus cửa sổ đó (tiến trình chính đang foreground nên Windows cho).
   */
  const peerItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  peerItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  let peerTimer: NodeJS.Timeout | undefined;
  ctx.subscriptions.push(peerItem, { dispose: () => clearTimeout(peerTimer) });
  function showPeerNotice(text: string, target: string): void {
    peerItem.text = text;
    peerItem.tooltip = target ? 'Click to switch to that window' : undefined;
    peerItem.command = target ? { title: 'Switch window', command: 'noIdle.focusPeer', arguments: [target] } : undefined;
    peerItem.show();
    clearTimeout(peerTimer);
    peerTimer = setTimeout(() => peerItem.hide(), PEER_NOTICE_MS);
  }
  function focusPeer(target: unknown): void {
    peerItem.hide();
    if (typeof target !== 'string' || !target) return;
    const cli = path.join(vscode.env.appRoot, 'out', 'cli.js');
    log(`nhảy sang cửa sổ ${target}`);
    const child = spawn(process.execPath, [cli, target], {
      // Như bin/code.cmd; bỏ VSCODE_IPC_HOOK_CLI để CLI nói thẳng với tiến trình chính, không qua cửa sổ này.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: undefined, VSCODE_IPC_HOOK_CLI: undefined },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => log(`không nhảy được sang cửa sổ ${target}: ${e.message}`));
    child.unref();
  }

  /**
   * Báo các cửa sổ VS Code khác: cửa sổ nào đang focus thì hiện một dòng tạm trên status bar. Nháy taskbar của cửa sổ
   * này không thấy được khi một cửa sổ VS Code khác đang ở trên cùng (chung tiến trình, chung một nút taskbar).
   */
  function tellPeers(reason: AttentionReason): void {
    const name = wsName();
    if (!name) return;
    const source = agentLabel === 'Claude' ? 'claude' : 'copilot';
    // cwd: file .code-workspace hay folder của cửa sổ này; cửa sổ nhận mở lại đúng nó bằng CLI để VS Code focus cửa sổ này.
    // Workspace chưa lưu (untitled) thì không có gì để mở lại: mở folder đầu sẽ ra cửa sổ mới, nên không cho bấm.
    const ws = vscode.workspace.workspaceFile;
    const own = ws ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const cwd = own?.scheme === 'file' ? own.fsPath : '';
    for (const e of readRegistry()) {
      if (e.pid === process.pid) continue;
      void signalPid(e.pid, { event: 'peerAttention', session: '', cwd, reason, text: name, source }).catch(() => undefined);
    }
  }

  /**
   * Handle cửa sổ này (Windows), học lúc cửa sổ vừa được focus: khi đó cửa sổ foreground là chính nó. VS Code không
   * cho extension biết handle, và mọi cửa sổ chung một tiến trình nên không tra theo pid được. Có handle thì nháy
   * đúng cửa sổ dù hai cửa sổ trùng tên workspace (hai "Untitled (Workspace)"). Học một lần; handle giữ suốt đời cửa sổ.
   */
  let myHwnd: string | undefined;
  let learningHwnd = false;
  const wsName = () => vscode.workspace.name ?? path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
  async function learnMyWindow(): Promise<void> {
    if (myHwnd || learningHwnd || process.platform !== 'win32' || !vscode.window.state.focused) return;
    learningHwnd = true;
    try {
      // Cửa sổ vừa mở hay vừa được focus: chờ OS đổi foreground xong rồi mới đọc, không thì đọc trúng cửa sổ cũ.
      await new Promise((r) => setTimeout(r, 800));
      if (!vscode.window.state.focused) return;
      const w = await learnForegroundWindow();
      if (!w) log('attention: không đọc được handle cửa sổ, sẽ nháy theo tên workspace');
      else if (!acceptLearnedWindow(w, wsName(), vscode.window.state.focused, hasEditor())) {
        log(`attention: cửa sổ foreground lúc đọc là "${w.title}", không phải cửa sổ này (hoặc đã mất focus); học lại lần focus sau`);
      } else {
        myHwnd = w.hwnd;
        log(`attention: cửa sổ này là hwnd ${w.hwnd} "${w.title}"`);
      }
    } finally {
      learningHwnd = false;
    }
  }
  void learnMyWindow();
  ctx.subscriptions.push(
    vscode.window.onDidChangeWindowState((st) => {
      // Sự kiện bắn cả khi `active` đổi: chỉ ghi mốc mất focus khi focused chuyển true → false.
      lastBlurAt = nextBlurAt({ prevFocused, focused: st.focused, prevBlurAt: lastBlurAt, now: Date.now() });
      prevFocused = st.focused;
      if (st.focused) {
        clearAttention();
        void learnMyWindow();
      }
    }),
  );

  const pipe = pipeName(process.pid);
  const server = startServer(pipe, (s) => onSignal(s).catch((err) => log(`lỗi tín hiệu: ${(err as Error).message}`)));
  const registerWindow = () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    try {
      // editorPid: tiến trình chính của VS Code (cha của extension host); hook coi cửa sổ của nó là editor dù tiêu đề là gì.
      writeRegistry({ pid: process.pid, pipe, folders, editorPid: process.ppid });
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
        releaseMic(process.pid);
        server.close();
      },
    },
    vscode.commands.registerCommand('noIdle.toggle', toggle),
    vscode.commands.registerCommand('noIdle.focusPeer', focusPeer),
    vscode.commands.registerCommand('noIdle.setApiKey', setApiKey),
    vscode.commands.registerCommand('noIdle.retry', retry),
    vscode.commands.registerCommand('noIdle.pickMic', pickMic),
    vscode.commands.registerCommand('noIdle.saveLastAudio', saveLastAudio),
    vscode.commands.registerCommand('noIdle.testVoice', testVoice),
    vscode.commands.registerCommand('noIdle.setElevenLabsApiKey', setElevenLabsApiKey),
    vscode.commands.registerCommand('noIdle.skipSpeech', skipSpeech),
    vscode.commands.registerCommand('noIdle.installFfmpeg', installFfmpeg),
    vscode.commands.registerCommand('noIdle.installNode', installNode),
    vscode.commands.registerCommand('noIdle.toggleMute', toggleMute),
    vscode.commands.registerCommand('noIdle.toggleHandsFree', toggleHandsFree),
    vscode.commands.registerCommand('noIdle.explainSelection', explainSelected),
  );
}

export function deactivate(): void {}
