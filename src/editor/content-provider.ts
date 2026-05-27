import * as vscode from "vscode";
import { getFileAtCommit } from "../git/content-provider.js";
import { TIMEWARP_SCHEME, decodeTimewarpUri } from "./uri-utils.js";

export class TimewarpContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const decoded = decodeTimewarpUri(uri);
    if (!decoded) {
      return "";
    }

    const content = await getFileAtCommit(decoded.filePath, decoded.commitHash);
    return content ?? `// File did not exist at commit ${decoded.commitHash}`;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export function registerContentProvider(context: vscode.ExtensionContext): TimewarpContentProvider {
  const provider = new TimewarpContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TIMEWARP_SCHEME, provider),
    provider,
  );
  return provider;
}
