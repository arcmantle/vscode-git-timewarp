import * as vscode from "vscode";
import { registerContentProvider } from "./editor/content-provider.js";
import { navigateBack, navigateForward, returnToPresent } from "./commands/navigate.js";

export function activate(context: vscode.ExtensionContext): void {
  // Register the timewarp: content provider
  registerContentProvider(context);

  // Status bar item for showing time position
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  // Register navigation commands
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimewarp.back", () => navigateBack(statusBar)),
    vscode.commands.registerCommand("gitTimewarp.forward", () => navigateForward(statusBar)),
    vscode.commands.registerCommand("gitTimewarp.returnToPresent", () => returnToPresent(statusBar)),
  );
}

export function deactivate(): void {}
