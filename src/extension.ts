import * as vscode from "vscode";
import { registerContentProvider } from "./editor/content-provider.js";
import { navigateBack, navigateForward, returnToPresent } from "./commands/navigate.js";
import { TimewarpWebviewPanel } from "./webview/timewarp-panel.js";
import { invalidateHighlighter, disposeHighlighter } from "./webview/highlighter.js";
import { runLocalHistoryDiagnostics } from "./history/local-history-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  // Register the timewarp: content provider
  registerContentProvider(context);

  // Status bar item for showing time position
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  // Invalidate highlighter cache when user switches themes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => invalidateHighlighter()),
  );

  // Register navigation commands
  context.subscriptions.push(
    vscode.commands.registerCommand("gitTimewarp.back", () => navigateBack(statusBar)),
    vscode.commands.registerCommand("gitTimewarp.forward", () => navigateForward(statusBar)),
    vscode.commands.registerCommand("gitTimewarp.returnToPresent", () => returnToPresent(statusBar)),
    vscode.commands.registerCommand("gitTimewarp.enterTimewarpView", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        vscode.window.showInformationMessage("Open a file to enter Git Timewarp scroll mode.");
        return;
      }
      const filePath = editor.document.uri.fsPath;
      const scrollLine = editor.selection.active.line;
      const panel = new TimewarpWebviewPanel(
        context.extensionUri,
        context.globalStorageUri,
        context.globalState,
        filePath,
      );
      await panel.open(editor.viewColumn ?? vscode.ViewColumn.One, scrollLine);
    }),
    vscode.commands.registerCommand("gitTimewarp.showLocalHistoryDiagnostics", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        vscode.window.showInformationMessage(
          "Open a file on disk to run Git Timewarp diagnostics.",
        );
        return;
      }
      await runLocalHistoryDiagnostics(editor.document.uri, context.globalStorageUri);
    }),
  );
}

export function deactivate(): void {
  disposeHighlighter();
}
