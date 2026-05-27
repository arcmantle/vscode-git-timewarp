import * as vscode from "vscode";
import { getConfig } from "../config.js";
import { applyDiffDecorations, clearDiffDecorations } from "../editor/diff-decorations.js";
import { getFileHistory } from "../git/history-provider.js";
import { getLocalHistory } from "../history/local-history-provider.js";
import { Timeline } from "../history/timeline.js";
import type { TimelineEntry } from "../history/types.js";
import { encodeTimewarpUri, TIMEWARP_SCHEME } from "../editor/uri-utils.js";

/** Per-file timeline state */
const timelineMap = new Map<string, Timeline>();

/** Debounce timer for rapid navigation */
let navigateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNavigation: (() => Promise<void>) | null = null;

/** Get or create the timeline for a file */
async function getTimeline(filePath: string, uri: vscode.Uri): Promise<Timeline> {
  let timeline = timelineMap.get(filePath);
  if (timeline) {
    return timeline;
  }

  timeline = new Timeline();

  const config = getConfig();
  const [commits, localHistory] = await Promise.all([
    getFileHistory(filePath, { maxCount: config.maxCommits }),
    config.includeLocalHistory ? getLocalHistory(uri) : Promise.resolve([]),
  ]);

  timeline.build(commits, localHistory, filePath);
  timelineMap.set(filePath, timeline);
  return timeline;
}

/** Resolve the "real" file path from either a timewarp URI or a file URI */
function resolveFilePath(editor: vscode.TextEditor): string | null {
  const uri = editor.document.uri;
  if (uri.scheme === TIMEWARP_SCHEME) {
    return uri.path;
  }
  if (uri.scheme === "file") {
    return uri.fsPath;
  }
  return null;
}

export async function navigateBack(statusBar: vscode.StatusBarItem): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const filePath = resolveFilePath(editor);
  if (!filePath) return;

  const fileUri = vscode.Uri.file(filePath);
  const timeline = await getTimeline(filePath, fileUri);

  const entry = timeline.back();
  if (!entry) {
    vscode.window.setStatusBarMessage("$(info) Beginning of file history", 2000);
    return;
  }

  // Debounce: advance cursor immediately but delay the editor switch
  debouncedShow(editor, entry, timeline, statusBar);
}

export async function navigateForward(statusBar: vscode.StatusBarItem): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const filePath = resolveFilePath(editor);
  if (!filePath) return;

  const fileUri = vscode.Uri.file(filePath);
  const timeline = await getTimeline(filePath, fileUri);

  const entry = timeline.forward();
  if (!entry) {
    // We're back at present
    await returnToPresent(statusBar);
    return;
  }

  debouncedShow(editor, entry, timeline, statusBar);
}

function debouncedShow(
  editor: vscode.TextEditor,
  entry: TimelineEntry,
  timeline: Timeline,
  statusBar: vscode.StatusBarItem,
): void {
  if (navigateTimer) {
    clearTimeout(navigateTimer);
  }

  // Update status bar immediately for responsiveness
  const ago = formatRelativeTime(entry.timestamp);
  const author = entry.authorName ? ` · @${entry.authorName}` : "";
  statusBar.text = `$(history) ${timeline.stepsFromPresent} back · ${ago}${author}`;
  statusBar.tooltip = entry.label;
  statusBar.show();

  pendingNavigation = async () => {
    const currentEntry = timeline.currentEntry;
    if (currentEntry) {
      await showHistoricalVersion(editor, currentEntry, timeline, statusBar);
    }
  };

  navigateTimer = setTimeout(() => {
    pendingNavigation?.();
    pendingNavigation = null;
    navigateTimer = null;
  }, getConfig().debounceMs);
}

export async function returnToPresent(statusBar: vscode.StatusBarItem): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const filePath = resolveFilePath(editor);
  if (!filePath) return;

  // Cancel any pending debounced navigation
  if (navigateTimer) {
    clearTimeout(navigateTimer);
    navigateTimer = null;
    pendingNavigation = null;
  }

  const timeline = timelineMap.get(filePath);
  if (timeline) {
    timeline.jumpToPresent();
  }

  // Save scroll position
  const cursorLine = editor.selection.active.line;
  const cursorChar = editor.selection.active.character;

  // Open the original file
  const fileUri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(fileUri);

  // Calculate target position before opening
  const maxLine = doc.lineCount - 1;
  const targetLine = Math.min(cursorLine, maxLine);
  const targetChar = Math.min(cursorChar, doc.lineAt(targetLine).text.length);
  const targetPosition = new vscode.Position(targetLine, targetChar);
  const targetSelection = new vscode.Selection(targetPosition, targetPosition);

  // Show document with selection pre-set
  const newEditor = await vscode.window.showTextDocument(doc, {
    viewColumn: editor.viewColumn,
    selection: targetSelection,
  });

  newEditor.revealRange(
    new vscode.Range(targetPosition, targetPosition),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );

  // Clear diff decorations and caches
  clearDiffDecorations(newEditor);

  // Update context and status bar
  await vscode.commands.executeCommand("setContext", "gitTimewarp.isTimeWarping", false);
  statusBar.hide();
}

async function showHistoricalVersion(
  editor: vscode.TextEditor,
  entry: TimelineEntry,
  timeline: Timeline,
  statusBar: vscode.StatusBarItem,
): Promise<void> {
  if (!entry.commitHash) return;

  // Save scroll position before switching
  const cursorLine = editor.selection.active.line;
  const cursorChar = editor.selection.active.character;

  // Pre-load the document content before showing it
  const uri = encodeTimewarpUri(entry.filePath, entry.commitHash, entry.label);
  const doc = await vscode.workspace.openTextDocument(uri);

  // Calculate target position before opening
  const maxLine = doc.lineCount - 1;
  const targetLine = Math.min(cursorLine, maxLine);
  const targetChar = Math.min(cursorChar, doc.lineAt(targetLine).text.length);
  const targetPosition = new vscode.Position(targetLine, targetChar);
  const targetSelection = new vscode.Selection(targetPosition, targetPosition);

  // Show document with selection pre-set to avoid jump
  const newEditor = await vscode.window.showTextDocument(doc, {
    viewColumn: editor.viewColumn,
    preview: true,
    preserveFocus: false,
    selection: targetSelection,
  });

  // Ensure the target line is centered in view
  newEditor.revealRange(
    new vscode.Range(targetPosition, targetPosition),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );

  // Apply diff decorations: compare this version to the previous (older) commit
  const olderEntry = timeline.getOlderEntry();
  if (olderEntry?.commitHash) {
    const { getFileAtCommit } = await import("../git/content-provider.js");
    const olderContent = await getFileAtCommit(entry.filePath, olderEntry.commitHash);
    if (olderContent !== null) {
      applyDiffDecorations(newEditor, doc.getText(), olderContent);
    }
  }

  // Set context for keybinding conditions
  await vscode.commands.executeCommand("setContext", "gitTimewarp.isTimeWarping", true);

  // Update status bar
  const ago = formatRelativeTime(entry.timestamp);
  const author = entry.authorName ? ` · @${entry.authorName}` : "";
  statusBar.text = `$(history) ${timeline.stepsFromPresent} back · ${ago}${author}`;
  statusBar.tooltip = entry.label;
  statusBar.show();
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function invalidateTimeline(filePath: string): void {
  timelineMap.delete(filePath);
}
