import * as vscode from "vscode";
import type { TimelineEntry } from "./types.js";

interface HistoryEntriesJson {
  resource: string;
  entries: { id: string; timestamp: number; source?: string }[];
}

/**
 * Replicates VS Code's internal hash function used to name local history directories.
 * Source: workbench.desktop.main.js — `yr(uri.toString()).toString(16)`
 * where yr calls Xwe (string hash) with w5 as the mixing step.
 */
function vscodeHistoryHash(str: string): string {
  function w5(a: number, i: number): number {
    return (((i << 5) - i + a) | 0);
  }
  let h = w5(149417, 0);
  for (let i = 0; i < str.length; i++) {
    h = w5(str.charCodeAt(i), h);
  }
  return h.toString(16);
}

/**
 * Reads VS Code's built-in local history for the given file.
 * History is stored at (userDataPath)/User/History/<hash>/entries.json
 * alongside the actual content files.
 *
 * Uses VS Code's deterministic hash to jump directly to the right directory
 * in O(1) instead of scanning all subdirectories.
 */
export async function getLocalHistory(
  uri: vscode.Uri,
  globalStorageUri: vscode.Uri | undefined,
): Promise<TimelineEntry[]> {
  if (!globalStorageUri) return [];
  try {
    const historyRoot = vscode.Uri.joinPath(globalStorageUri, "..", "..", "History");
    const fileUriStr = uri.toString();

    const dirName = vscodeHistoryHash(fileUriStr);
    const entriesUri = vscode.Uri.joinPath(historyRoot, dirName, "entries.json");

    let model: HistoryEntriesJson;
    try {
      const raw = await vscode.workspace.fs.readFile(entriesUri);
      model = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return []; // No history for this file
    }

    if (!model.entries?.length) return [];

    return model.entries.map((e) => {
      // e.id already includes the file extension (e.g. "bjYK.ts")
      const contentUri = vscode.Uri.joinPath(historyRoot, dirName, e.id);
      return {
        id: `local:${e.id}`,
        timestamp: e.timestamp,
        label: "Local save",
        source: "local-history" as const,
        localContentUri: contentUri.toString(),
        filePath: uri.fsPath,
      };
    });
  } catch {
    return [];
  }
}

/** Read the file content stored at a local history entry's content URI. */
export async function getFileAtLocalEntry(localContentUri: string): Promise<string | null> {
  try {
    const uri = vscode.Uri.parse(localContentUri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
