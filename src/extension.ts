import * as vscode from 'vscode';
import { StatusBar } from './status';
import { Recorder } from './recorder';
import { listAudioDevices } from './devices';
import { transcribe, TranscribeError } from './transcriber';
import { inject, InjectorApi, Target } from './injector';
import { audioLevel } from './wav';
import * as fs from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const SECRET_KEY = 'viVoice.groqApiKey';
const MAX_RECORD_MS = 120_000;
const MIN_RECORD_MS = 500;
/** Dưới mức này coi như không có tiếng nói, không gửi Groq (tránh Whisper bịa câu). */
const QUIET_PEAK_DB = -40;

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
  return {
    ffmpegPath: c.get<string>('ffmpegPath', 'ffmpeg') || 'ffmpeg',
    micDevice: c.get<string>('micDevice', '') || undefined,
  };
}

/**
 * Terminal gửi mọi phím cho shell trừ các lệnh trong commandsToSkipShell.
 * Không có dòng này thì Ctrl+Alt+Space trong terminal thành ký tự lạ thay vì bật Vi Voice.
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

export function activate(ctx: vscode.ExtensionContext): void {
  const status = new StatusBar();
  void ensureTerminalSkipShell().catch(() => undefined);
  let recorder = new Recorder(config());
  const api: InjectorApi = {
    activeTerminal: () => vscode.window.activeTerminal,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
    readClipboard: () => vscode.env.clipboard.readText(),
    pasteKeystroke: sendCtrlV,
  };

  let target: Target = 'clipboard';
  let busy = false;
  let lastAudio: Uint8Array | undefined;
  let maxTimer: NodeJS.Timeout | undefined;

  // Đổi setting ffmpeg/mic thì tạo recorder mới.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('viVoice')) {
        recorder.dispose();
        recorder = new Recorder(config());
      }
    }),
  );

  async function setApiKey(): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      prompt: 'Groq API key (bắt đầu bằng gsk_). Lấy miễn phí tại console.groq.com/keys',
      password: true,
      ignoreFocusOut: true,
    });
    const key = value?.trim();
    if (key) await ctx.secrets.store(SECRET_KEY, key);
    return key || undefined;
  }

  async function getApiKey(): Promise<string | undefined> {
    return (await ctx.secrets.get(SECRET_KEY)) ?? setApiKey();
  }

  async function deliver(audio: Uint8Array): Promise<void> {
    const apiKey = await getApiKey();
    if (!apiKey) return;
    status.set('transcribing');
    try {
      const text = await transcribe(audio, { apiKey });
      if (!text) {
        void vscode.window.showWarningMessage('Vi Voice: không nghe được gì');
        return;
      }
      const used = await inject(target, text, api);
      if (used === 'clipboard') {
        void vscode.window.showInformationMessage(`Vi Voice: đã copy vào clipboard: "${text}"`);
      }
    } catch (err) {
      lastAudio = audio;
      if (err instanceof TranscribeError && err.kind === 'auth') {
        const pick = await vscode.window.showErrorMessage(`Vi Voice: ${err.message}`, 'Nhập lại key');
        if (pick) await setApiKey();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const pick = await vscode.window.showErrorMessage(`Vi Voice: ${message}`, 'Gửi lại');
        if (pick) void vscode.commands.executeCommand('viVoice.retry');
      }
    } finally {
      status.set('idle');
    }
  }

  async function toggle(args?: { target?: Target }): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (!recorder.recording) {
        if (!(await getApiKey())) return;
        target = args?.target ?? 'clipboard';
        await recorder.start();
        status.set('recording');
        maxTimer = setTimeout(() => void vscode.commands.executeCommand('viVoice.toggle'), MAX_RECORD_MS);
        return;
      }
      clearTimeout(maxTimer);
      const audio = await recorder.stop();
      lastAudio = audio;
      if (Recorder.durationMs(audio) < MIN_RECORD_MS) {
        status.set('idle');
        return;
      }
      const level = audioLevel(audio);
      if (level.peakDb < QUIET_PEAK_DB) {
        status.set('idle');
        void vscode.window.showWarningMessage(
          `Vi Voice: mic gần như im lặng (peak ${level.peakDb.toFixed(0)} dB, rms ${level.rmsDb.toFixed(0)} dB). ` +
            'Kiểm tra mic trong Windows Settings > Sound > Input, hoặc chạy lệnh "Vi Voice: Chọn micro".',
        );
        return;
      }
      await deliver(audio);
    } catch (err) {
      status.set('idle');
      void vscode.window.showErrorMessage(`Vi Voice: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }

  async function retry(): Promise<void> {
    if (!lastAudio) {
      void vscode.window.showInformationMessage('Vi Voice: không có audio để gửi lại');
      return;
    }
    await deliver(lastAudio);
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

  ctx.subscriptions.push(
    status,
    { dispose: () => recorder.dispose() },
    vscode.commands.registerCommand('viVoice.saveLastAudio', saveLastAudio),
    vscode.commands.registerCommand('viVoice.toggle', toggle),
    vscode.commands.registerCommand('viVoice.setApiKey', setApiKey),
    vscode.commands.registerCommand('viVoice.retry', retry),
    vscode.commands.registerCommand('viVoice.pickMic', pickMic),
  );
}

export function deactivate(): void {}
