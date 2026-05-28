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
// Cache resolved hash directory names to avoid repeated fallback scans.
const dirNameCache = new Map<string, string>();
// Negative cache: URIs known to have no local-history entry. Avoids
// re-scanning the entire history root every time the user navigates an
// unrelated file.
const missingCache = new Set<string>();
// Dedupe concurrent scans for the same URI.
const inflightScans = new Map<
  string,
  Promise<{ dirName: string; model: HistoryEntriesJson } | null>
>();

// Persistent index stored in VS Code's Memento (sqlite-backed state.db).
// Maps fileUri.toString() -> history directory name. Hydrated once per
// session; written through whenever a scan resolves a new mapping. This
// lets us avoid the expensive fallback scan on subsequent sessions on
// platforms where the deterministic hash doesn't match (Windows).
const INDEX_KEY = "gitTimewarp.localHistoryDirIndex";
let indexHydrated = false;
let indexMemento: vscode.Memento | undefined;

function hydrateIndex(memento: vscode.Memento | undefined): void {
  if (indexHydrated || !memento) return;
  indexHydrated = true;
  indexMemento = memento;
  const stored = memento.get<Record<string, string>>(INDEX_KEY, {});
  for (const [uri, dirName] of Object.entries(stored)) {
    if (!dirNameCache.has(uri)) dirNameCache.set(uri, dirName);
  }
}

function persistMapping(fileUriStr: string, dirName: string): void {
  if (!indexMemento) return;
  const stored = indexMemento.get<Record<string, string>>(INDEX_KEY, {});
  if (stored[fileUriStr] === dirName) return;
  stored[fileUriStr] = dirName;
  // Fire-and-forget; Memento.update is async but we don't need to await.
  void indexMemento.update(INDEX_KEY, stored);
}

async function tryReadEntries(
  historyRoot: vscode.Uri,
  name: string,
): Promise<HistoryEntriesJson | null> {
  try {
    const entriesUri = vscode.Uri.joinPath(historyRoot, name, "entries.json");
    const raw = await vscode.workspace.fs.readFile(entriesUri);
    return JSON.parse(new TextDecoder().decode(raw)) as HistoryEntriesJson;
  } catch {
    return null;
  }
}

/**
 * Scan the history root for the folder whose entries.json references our
 * file. Needed on platforms where the URI string form differs from what
 * we computed (e.g. Windows drive-letter casing/encoding quirks).
 *
 * Wrapped in a VS Code progress notification so the user knows why the
 * panel takes a moment to populate. The scan itself yields between
 * batches so it cannot starve the extension host event loop.
 */
async function scanHistoryRoot(
  historyRoot: vscode.Uri,
  fileUriStr: string,
  token: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<{ dirName: string; model: HistoryEntriesJson } | null> {
  let children: [string, vscode.FileType][];
  try {
    children = await vscode.workspace.fs.readDirectory(historyRoot);
  } catch {
    return null;
  }

  const candidates = children
    .filter(([, type]) => type === vscode.FileType.Directory)
    .map(([name]) => name);

  const total = candidates.length;
  const batchSize = 16;
  const incrementPerBatch = total > 0 ? (100 / Math.ceil(total / batchSize)) : 100;

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (token.isCancellationRequested) return null;
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (name) => ({ name, model: await tryReadEntries(historyRoot, name) })),
    );
    for (const { name, model } of results) {
      if (model && model.resource === fileUriStr) {
        return { dirName: name, model };
      }
    }
    progress.report({
      message: `${Math.min(i + batchSize, total)} / ${total}`,
      increment: incrementPerBatch,
    });
    // Yield to the event loop so other extension-host work can run
    // between batches. readDirectory/readFile already await, but this
    // makes the cooperative scheduling explicit.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  return null;
}

async function findHistoryDir(
  historyRoot: vscode.Uri,
  fileUriStr: string,
): Promise<{ dirName: string; model: HistoryEntriesJson } | null> {
  // 1. Try the deterministic hash first (fast path)
  const hashName = vscodeHistoryHash(fileUriStr);
  const cachedName = dirNameCache.get(fileUriStr) ?? hashName;

  const direct = await tryReadEntries(historyRoot, cachedName);
  if (direct && direct.resource === fileUriStr) {
    dirNameCache.set(fileUriStr, cachedName);
    persistMapping(fileUriStr, cachedName);
    return { dirName: cachedName, model: direct };
  }

  // 2. Negative-cache short-circuit: don't repeatedly scan for files
  //    that have no history (e.g. brand-new untracked files).
  if (missingCache.has(fileUriStr)) return null;

  // 3. Dedupe concurrent scans.
  const existing = inflightScans.get(fileUriStr);
  if (existing) return existing;

  // 4. Fallback: scan, wrapped in a progress notification.
  const scan = Promise.resolve(
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Git Timewarp: locating local history…",
        cancellable: true,
      },
      (progress, token) => scanHistoryRoot(historyRoot, fileUriStr, token, progress),
    ),
  ).then((result) => {
    if (result) {
      dirNameCache.set(fileUriStr, result.dirName);
      persistMapping(fileUriStr, result.dirName);
    } else {
      missingCache.add(fileUriStr);
    }
    return result;
  }).finally(() => {
    inflightScans.delete(fileUriStr);
  });

  inflightScans.set(fileUriStr, scan);
  return scan;
}

export async function getLocalHistory(
  uri: vscode.Uri,
  globalStorageUri: vscode.Uri | undefined,
  memento?: vscode.Memento,
): Promise<TimelineEntry[]> {
  if (!globalStorageUri) return [];
  hydrateIndex(memento);
  try {
    const historyRoot = vscode.Uri.joinPath(globalStorageUri, "..", "..", "History");
    const fileUriStr = uri.toString();

    const found = await findHistoryDir(historyRoot, fileUriStr);
    if (!found) return [];

    const { dirName, model } = found;
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
