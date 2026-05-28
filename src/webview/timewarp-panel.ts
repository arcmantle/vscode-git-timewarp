import * as vscode from "vscode";
import { basename } from "node:path";
import { getFileHistory, getBlameForLines } from "../git/history-provider.js";
import { getFileAtCommit } from "../git/content-provider.js";
import { getLocalHistory, getFileAtLocalEntry } from "../history/local-history-provider.js";
import { Timeline } from "../history/timeline.js";
import { getConfig } from "../config.js";
import { highlightCode } from "./highlighter.js";
import type { TimelineEntry } from "../history/types.js";
import type {
  ToWebviewMessage,
  FromWebviewMessage,
  HighlightedLine,
  TimelineMode,
  SplitMode,
} from "./messages.js";

const PREF_TIMELINE_MODE = "gitTimewarp.timelineMode";
const PREF_SPLIT_MODE = "gitTimewarp.splitMode";

export class TimewarpWebviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private timeline: Timeline | null = null;
  private filePath: string;
  private fileUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private currentContent: string = "";
  private previousContent: string | null = null;
  private highlightCache = new Map<string, HighlightedLine[]>();
  private gitCommitCount = 0;
  private localEntryCount = 0;
  private localHistoryLoaded = false;
  private visibleStepsBack = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
    private readonly memento: vscode.Memento,
    filePath: string,
  ) {
    this.filePath = filePath;
    this.fileUri = vscode.Uri.file(filePath);
  }

  async open(viewColumn: vscode.ViewColumn, scrollLine?: number): Promise<void> {
    // Restore previous UI preferences (default to git mode, no split)
    const savedTimelineMode = this.memento.get<TimelineMode>(PREF_TIMELINE_MODE, "git");
    const savedSplitMode = this.memento.get<SplitMode>(PREF_SPLIT_MODE, "");

    // Build timeline. Lazy-load local history only if it's the saved mode.
    const config = getConfig();
    this.timeline = new Timeline();

    const commits = await getFileHistory(this.filePath, { maxCount: config.maxCommits });
    this.timeline.build(commits, [], this.filePath);
    this.gitCommitCount = commits.length;
    this.localEntryCount = 0;

    if (savedTimelineMode === "local") {
      const localHistory = config.includeLocalHistory
        ? await getLocalHistory(this.fileUri, this.globalStorageUri)
        : [];
      this.timeline.addLocalHistory(localHistory);
      this.localHistoryLoaded = true;
      this.localEntryCount = this.timeline.localCount;
      this.timeline.setFilterMode("local");
    }

    // Read current file content
    const bytes = await vscode.workspace.fs.readFile(this.fileUri);
    this.currentContent = new TextDecoder().decode(bytes);

    // Create webview panel
    const fileName = basename(this.filePath) || "file";
    this.panel = vscode.window.createWebviewPanel(
      "gitTimewarp.scrollView",
      fileName,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "icon-color-square.png"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "icon-color-square.png"),
    };

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // Set initial HTML and send current content
    this.panel.webview.html = this.getWebviewHtml();

    // Send initial content (highlighted)
    const lang = this.getLanguageId();
    const highlightedLines = await highlightCode(this.currentContent, lang);
    await this.postToWebview({
      type: "init",
      highlightedLines,
      language: lang,
      fileName,
      scrollLine: scrollLine ?? 0,
      totalCommits: this.timeline.length,
      totalLocalEntries: this.localEntryCount,
      timelineMode: savedTimelineMode,
      splitMode: savedSplitMode,
    });
  }

  private postToWebview(msg: ToWebviewMessage): Thenable<boolean> {
    return this.panel!.webview.postMessage(msg);
  }

  private async handleMessage(msg: FromWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "scroll-back":
        await this.navigateBack();
        break;
      case "scroll-forward":
        await this.navigateForward();
        break;
      case "request-present":
        await this.sendSplitContent("present");
        break;
      case "request-previous":
        await this.sendSplitContent("previous");
        break;
      case "set-timeline-mode":
        if (this.timeline) {
          // Lazy-load local history the first time Local mode is requested
          if (msg.mode === "local" && !this.localHistoryLoaded) {
            const config = getConfig();
            const localHistory = config.includeLocalHistory
              ? await getLocalHistory(this.fileUri, this.globalStorageUri)
              : [];
            this.timeline.addLocalHistory(localHistory);
            this.localHistoryLoaded = true;
            this.localEntryCount = this.timeline.localCount;
          }
          this.timeline.setFilterMode(msg.mode);
          this.visibleStepsBack = 0;
          void this.memento.update(PREF_TIMELINE_MODE, msg.mode);
          const lang = this.getLanguageId();
          const highlightedLines = await highlightCode(this.currentContent, lang);
          await this.postToWebview({
            type: "content",
            highlightedLines,
            stepsBack: 0,
            diffLines: [],
            totalEntries: this.timeline.length,
          });
        }
        break;
      case "set-split-mode":
        void this.memento.update(PREF_SPLIT_MODE, msg.mode);
        break;
      case "exit":
        this.dispose();
        // Re-open the original file
        const doc = await vscode.workspace.openTextDocument(this.fileUri);
        await vscode.window.showTextDocument(doc);
        break;
    }
  }

  private splitMode: "present" | "previous" | "" = "";

  private async sendSplitContent(mode: "present" | "previous"): Promise<void> {
    if (!this.panel) return;
    this.splitMode = mode;

    if (mode === "present") {
      const hlCacheKey = "present";
      let highlightedLines = this.highlightCache.get(hlCacheKey);
      if (!highlightedLines) {
        highlightedLines = await highlightCode(this.currentContent, this.getLanguageId());
        this.highlightCache.set(hlCacheKey, highlightedLines);
      }
      await this.postToWebview({
        type: "split-content",
        highlightedLines,
      });
    } else {
      // "previous" — get the commit before the currently viewed one
      await this.sendPreviousCommitContent();
    }
  }

  private async sendPreviousCommitContent(): Promise<void> {
    if (!this.panel || !this.timeline) return;

    const olderEntry = this.timeline.getOlderEntry();
    const currentEntry = this.timeline.currentEntry;
    if (olderEntry) {
      const olderContent = await this.getEntryContent(olderEntry);
      if (olderContent !== null) {
        const hlCacheKey = olderEntry.commitHash ?? olderEntry.id;
        let highlightedLines = this.highlightCache.get(hlCacheKey);
        if (!highlightedLines) {
          highlightedLines = await highlightCode(olderContent, this.getLanguageId());
          this.highlightCache.set(hlCacheKey, highlightedLines);
        }

        // Compute removed lines: lines in older that don't exist in current
        let diffLines: number[] = [];
        if (currentEntry) {
          const currentContent = await this.getEntryContent(currentEntry);
          if (currentContent !== null) {
            diffLines = computeChangedLines(olderContent, currentContent);
          }
        }

        await this.postToWebview({
          type: "split-content",
          highlightedLines,
          diffLines,
        });
        return;
      }
    }
    // No older entry — show the current entry's content (beginning of history)
    const fallbackEntry = this.timeline.currentEntry;
    const fallbackContent = fallbackEntry
      ? await this.getEntryContent(fallbackEntry)
      : this.currentContent;
    if (fallbackContent !== null) {
      const hlCacheKey = fallbackEntry ? (fallbackEntry.commitHash ?? fallbackEntry.id) + "_fb" : "present";
      let highlightedLines = this.highlightCache.get(hlCacheKey);
      if (!highlightedLines) {
        highlightedLines = await highlightCode(fallbackContent, this.getLanguageId());
        this.highlightCache.set(hlCacheKey, highlightedLines);
      }
      await this.postToWebview({ type: "split-content", highlightedLines, diffLines: [] });
    } else {
      await this.postToWebview({ type: "split-content", highlightedLines: [], diffLines: [] });
    }
  }

  private async navigateBack(): Promise<void> {
    if (!this.timeline || !this.panel) return;

    let entry = this.timeline.back();
    while (entry && !entry.commitHash && !entry.localContentUri) {
      entry = this.timeline.back();
    }
    if (!entry) {
      await this.postToWebview({ type: "boundary", direction: "oldest" });
      return;
    }

    this.visibleStepsBack++;
    await this.showEntry(entry);
  }

  private async navigateForward(): Promise<void> {
    if (!this.timeline || !this.panel) return;

    let entry = this.timeline.forward();
    while (entry && !entry.commitHash && !entry.localContentUri) {
      entry = this.timeline.forward();
    }
    if (!entry) {
      // Back at present
      this.visibleStepsBack = 0;
      const highlightedLines = await highlightCode(this.currentContent, this.getLanguageId());
      await this.postToWebview({
        type: "content",
        highlightedLines,
        stepsBack: 0,
        diffLines: [],
      });
      return;
    }

    this.visibleStepsBack--;
    await this.showEntry(entry);
  }

  private async getEntryContent(entry: TimelineEntry): Promise<string | null> {
    if (entry.commitHash) {
      return getFileAtCommit(this.filePath, entry.commitHash);
    }
    if (entry.localContentUri) {
      return getFileAtLocalEntry(entry.localContentUri);
    }
    return null;
  }

  private async showEntry(entry: TimelineEntry): Promise<void> {
    if (!this.panel || !this.timeline) return;

    const content = await this.getEntryContent(entry);
    if (content === null) {
      await this.postToWebview({ type: "boundary", direction: "oldest" });
      return;
    }

    // Get the older entry for diff
    const olderEntry = this.timeline.getOlderEntry();
    let diffLines: number[] = [];
    let deletedRanges: { afterLine: number; lines: string[] }[] = [];
    if (olderEntry) {
      const olderContent = await this.getEntryContent(olderEntry);
      if (olderContent !== null) {
        diffLines = computeChangedLines(content, olderContent);
        deletedRanges = computeDeletedPositions(content, olderContent);
      }
    }

    const ago = formatRelativeTime(entry.timestamp);
    const author = entry.authorName ? `@${entry.authorName}` : "";

    // Blame only available for git entries
    let blame: Record<number, string> = {};
    if (diffLines.length > 0 && entry.commitHash) {
      blame = await getBlameForLines(this.filePath, entry.commitHash, diffLines);
    }

    // Highlight the content (cached per entry id)
    const hlCacheKey = entry.commitHash ?? entry.id;
    let highlightedLines = this.highlightCache.get(hlCacheKey);
    if (!highlightedLines) {
      highlightedLines = await highlightCode(content, this.getLanguageId());
      this.highlightCache.set(hlCacheKey, highlightedLines);
    }

    await this.postToWebview({
      type: "content",
      highlightedLines,
      stepsBack: this.visibleStepsBack,
      ago,
      author,
      commitMessage: entry.label,
      diffLines,
      deletedRanges,
      blame,
    });

    // Update split pane if in "previous" mode
    if (this.splitMode === "previous") {
      await this.sendPreviousCommitContent();
    }
  }

  private getLanguageId(): string {
    const ext = this.filePath.split(".").pop() || "";
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      json: "json",
      md: "markdown",
      css: "css",
      scss: "scss",
      html: "html",
      vue: "vue",
      svelte: "svelte",
      py: "python",
      rs: "rust",
      go: "go",
      rb: "ruby",
      java: "java",
      kt: "kotlin",
      swift: "swift",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      sh: "bash",
      zsh: "bash",
      yml: "yaml",
      yaml: "yaml",
      toml: "toml",
      xml: "xml",
      sql: "sql",
      graphql: "graphql",
      dockerfile: "dockerfile",
      mjs: "javascript",
      mts: "typescript",
    };
    return map[ext] || "text";
  }

  private getWebviewHtml(): string {
    const webview = this.panel!.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );

    return /* html */ `
		<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
				<style>
					* { margin: 0; padding: 0; box-sizing: border-box; }
					body { overflow: hidden; height: 100vh; }
				</style>
			</head>
			<body>
				<timewarp-app></timewarp-app>
				<script type="module" src="${scriptUri}"></script>
			</body>
		</html>
	`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

function computeChangedLines(content: string, olderContent: string): number[] {
  const lines = content.split("\n");
  const olderLines = olderContent.split("\n");
  const changed: number[] = [];

  // Build set of lines in older content for quick lookup
  const olderSet = new Set(olderLines);

  // Simple heuristic: mark lines in content that don't exist anywhere in older
  // This is fast and good enough for gutter highlighting
  for (let i = 0; i < lines.length; i++) {
    if (!olderSet.has(lines[i])) {
      changed.push(i);
    }
  }

  return changed;
}

/**
 * Compute where lines were deleted relative to the current content.
 * Returns positions in the current file where deletions occurred,
 * along with the actual deleted text.
 */
function computeDeletedPositions(
  content: string,
  olderContent: string,
): { afterLine: number; lines: string[] }[] {
  const currentLines = content.split("\n");
  const olderLines = olderContent.split("\n");
  const currentSet = new Set(currentLines);

  // Find lines in older that don't exist in current
  const removedLines: number[] = [];
  for (let i = 0; i < olderLines.length; i++) {
    if (!currentSet.has(olderLines[i])) {
      removedLines.push(i);
    }
  }

  if (removedLines.length === 0) return [];

  // Map removed line positions to approximate positions in current file
  const ranges: { afterLine: number; lines: string[] }[] = [];
  const removedSet = new Set(removedLines);

  let currentIdx = 0;
  let i = 0;
  while (i < olderLines.length) {
    if (removedSet.has(i)) {
      const deletedLines: string[] = [];
      while (i < olderLines.length && removedSet.has(i)) {
        deletedLines.push(olderLines[i]);
        i++;
      }
      ranges.push({ afterLine: currentIdx, lines: deletedLines });
    } else {
      // This line exists in current — advance current pointer
      currentIdx++;
      i++;
    }
  }

  return ranges;
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
