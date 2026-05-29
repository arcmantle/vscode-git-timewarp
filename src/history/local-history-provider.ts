import * as vscode from "vscode";
import type { TimelineEntry } from "./types.js";

interface HistoryEntriesJson {
  resource: string;
  entries: { id: string; timestamp: number; source?: string }[];
}

// Lazy output channel for diagnostics. Created on first log; users can
// view it via View → Output → "Git Timewarp".
let _output: vscode.OutputChannel | undefined;
function log(msg: string): void {
  if (!_output) _output = vscode.window.createOutputChannel("Git Timewarp");
  _output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_output) _output = vscode.window.createOutputChannel("Git Timewarp");
  return _output;
}

/**
 * Windows file URIs are case-insensitive on disk. Normalize for comparison
 * by lowercasing the drive letter portion of the path. We deliberately do
 * NOT lowercase the whole string because the rest of the path may be
 * case-sensitive on some filesystems.
 */
function normalizeForCompare(uriStr: string): string {
  // file:///C%3A/... -> file:///c%3A/...
  return uriStr.replace(/^(file:\/\/\/)([A-Z])(%3A|%3a|:)/i, (_, p, d, c) =>
    `${p}${d.toLowerCase()}${c.toLowerCase()}`,
  );
}

function resourceMatches(stored: string, requested: string): boolean {
  if (stored === requested) return true;
  // Try a normalized comparison so Windows drive-letter casing variants match.
  if (normalizeForCompare(stored) === normalizeForCompare(requested)) return true;
  // Last resort: compare as fsPath (handles encoding differences).
  try {
    const a = vscode.Uri.parse(stored).fsPath;
    const b = vscode.Uri.parse(requested).fsPath;
    return process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  } catch {
    return false;
  }
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
// unrelated file. Entries expire after MISSING_TTL_MS so newly created
// history is eventually picked up without an extension reload.
const MISSING_TTL_MS = 30_000;
const missingCache = new Map<string, number>();
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
      if (model && resourceMatches(model.resource, fileUriStr)) {
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

  log(`findHistoryDir: file=${fileUriStr}`);
  log(`  historyRoot=${historyRoot.toString()}`);
  log(`  hashName=${hashName} cachedName=${cachedName}`);

  const direct = await tryReadEntries(historyRoot, cachedName);
  if (direct) {
    log(`  direct hit: entries.json.resource=${direct.resource}`);
    if (resourceMatches(direct.resource, fileUriStr)) {
      dirNameCache.set(fileUriStr, cachedName);
      persistMapping(fileUriStr, cachedName);
      log(`  -> matched dir=${cachedName}`);
      return { dirName: cachedName, model: direct };
    }
    log(`  resource mismatch, falling back to scan`);
  } else {
    log(`  no entries.json at ${cachedName}, falling back to scan`);
  }

  // 2. Negative-cache short-circuit (TTL'd so new history is picked up).
  const missAt = missingCache.get(fileUriStr);
  if (missAt !== undefined && Date.now() - missAt < MISSING_TTL_MS) {
    log(`  negative-cache hit (age=${Date.now() - missAt}ms), skipping scan`);
    return null;
  }
  if (missAt !== undefined) missingCache.delete(fileUriStr);

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
      log(`  scan resolved dir=${result.dirName}`);
    } else {
      missingCache.set(fileUriStr, Date.now());
      log(`  scan found no match for ${fileUriStr}`);
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
  if (!globalStorageUri) {
    log(`getLocalHistory: no globalStorageUri, returning []`);
    return [];
  }
  hydrateIndex(memento);
  try {
    const historyRoot = vscode.Uri.joinPath(globalStorageUri, "..", "..", "History");
    const fileUriStr = uri.toString();

    // Verify the root exists; surface a clear log line if not.
    try {
      await vscode.workspace.fs.stat(historyRoot);
    } catch (e) {
      log(`getLocalHistory: historyRoot does not exist: ${historyRoot.toString()} (${String(e)})`);
      return [];
    }

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
  } catch (e) {
    log(`getLocalHistory: unexpected error: ${String(e)}`);
    return [];
  }
}

/**
 * Diagnostic helper invoked by the "Git Timewarp: Show Local History Diagnostics"
 * command. Prints everything we need to debug missing local history into the
 * output channel and reveals it.
 */
export async function runLocalHistoryDiagnostics(
  uri: vscode.Uri,
  globalStorageUri: vscode.Uri | undefined,
): Promise<void> {
  const ch = getOutputChannel();
  ch.show(true);
  ch.appendLine("");
  ch.appendLine("=== Git Timewarp diagnostics ===");
  ch.appendLine(`platform: ${process.platform}`);
  ch.appendLine(`file fsPath: ${uri.fsPath}`);
  ch.appendLine(`file uri:    ${uri.toString()}`);
  ch.appendLine(`globalStorageUri: ${globalStorageUri?.toString() ?? "(undefined)"}`);
  if (!globalStorageUri) return;

  const historyRoot = vscode.Uri.joinPath(globalStorageUri, "..", "..", "History");
  ch.appendLine(`historyRoot: ${historyRoot.toString()}`);
  ch.appendLine(`historyRoot fsPath: ${historyRoot.fsPath}`);

  try {
    const stat = await vscode.workspace.fs.stat(historyRoot);
    ch.appendLine(`historyRoot exists (type=${stat.type})`);
  } catch (e) {
    ch.appendLine(`historyRoot does NOT exist: ${String(e)}`);
    return;
  }

  const fileUriStr = uri.toString();
  const hashName = vscodeHistoryHash(fileUriStr);
  ch.appendLine(`computed hash dir: ${hashName}`);

  // Try the direct hash.
  const direct = await tryReadEntries(historyRoot, hashName);
  if (direct) {
    ch.appendLine(`direct entries.json found at ${hashName}`);
    ch.appendLine(`  stored resource: ${direct.resource}`);
    ch.appendLine(`  match: ${resourceMatches(direct.resource, fileUriStr)}`);
    ch.appendLine(`  entry count: ${direct.entries?.length ?? 0}`);
  } else {
    ch.appendLine(`no entries.json at hash ${hashName}; scanning...`);
  }

  // Full scan, looking for any entries.json whose resource references this file.
  let children: [string, vscode.FileType][];
  try {
    children = await vscode.workspace.fs.readDirectory(historyRoot);
  } catch (e) {
    ch.appendLine(`readDirectory failed: ${String(e)}`);
    return;
  }
  ch.appendLine(`scanning ${children.length} entries under historyRoot...`);

  const fsPathLower = uri.fsPath.toLowerCase();
  const matches: { name: string; resource: string; entries: number }[] = [];
  for (const [name, type] of children) {
    if (type !== vscode.FileType.Directory) continue;
    const model = await tryReadEntries(historyRoot, name);
    if (!model) continue;
    let storedFsPath = "";
    try {
      storedFsPath = vscode.Uri.parse(model.resource).fsPath.toLowerCase();
    } catch {
      // ignore
    }
    if (
      resourceMatches(model.resource, fileUriStr) ||
      storedFsPath === fsPathLower
    ) {
      matches.push({ name, resource: model.resource, entries: model.entries?.length ?? 0 });
    }
  }

  if (matches.length === 0) {
    ch.appendLine(`no entries.json references this file. VS Code has no local history for it.`);
  } else {
    ch.appendLine(`found ${matches.length} matching dir(s):`);
    for (const m of matches) {
      ch.appendLine(`  dir=${m.name} entries=${m.entries} resource=${m.resource}`);
    }
  }
  ch.appendLine("=== end diagnostics ===");
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
