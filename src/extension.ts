import * as vscode from 'vscode';
import { StatusBar } from './status';
import { Recorder } from './recorder';
import { listAudioDevices } from './devices';
import { transcribe, TranscribeError } from './transcriber';
import { inject, InjectorApi, Target } from './injector';

const SECRET_KEY = 'viVoice.groqApiKey';
const MAX_RECORD_MS = 120_000;
const MIN_RECORD_MS = 500;

function config() {
  const c = vscode.workspace.getConfiguration('viVoice');
  return {
    ffmpegPath: c.get<string>('ffmpegPath', 'ffmpeg') || 'ffmpeg',
    micDevice: c.get<string>('micDevice', '') || undefined,
  };
}

export function activate(ctx: vscode.ExtensionContext): void {
  const status = new StatusBar();
  let recorder = new Recorder(config());
  const api: InjectorApi = {
    activeTerminal: () => vscode.window.activeTerminal,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
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
      lastAudio = undefined;
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
      if (Recorder.durationMs(audio) < MIN_RECORD_MS) {
        status.set('idle');
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

  ctx.subscriptions.push(
    status,
    { dispose: () => recorder.dispose() },
    vscode.commands.registerCommand('viVoice.toggle', toggle),
    vscode.commands.registerCommand('viVoice.setApiKey', setApiKey),
    vscode.commands.registerCommand('viVoice.retry', retry),
    vscode.commands.registerCommand('viVoice.pickMic', pickMic),
  );
}

export function deactivate(): void {}
