import * as vscode from 'vscode';
import { StatusBar } from './status';

export function activate(ctx: vscode.ExtensionContext): void {
  const status = new StatusBar();
  ctx.subscriptions.push(
    status,
    vscode.commands.registerCommand('viVoice.toggle', () => {
      void vscode.window.showInformationMessage('Vi Voice: toggle (chưa nối)');
    }),
    vscode.commands.registerCommand('viVoice.setApiKey', () => undefined),
    vscode.commands.registerCommand('viVoice.retry', () => undefined),
  );
}

export function deactivate(): void {}
