import * as vscode from "vscode";
import { getFileHistory, getBlameForLines } from "../git/history-provider.js";
import { getFileAtCommit } from "../git/content-provider.js";
import { getLocalHistory } from "../history/local-history-provider.js";
import { Timeline } from "../history/timeline.js";
import { getConfig } from "../config.js";
import { highlightCode } from "./highlighter.js";
import type { TimelineEntry } from "../history/types.js";

export class TimewarpWebviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private timeline: Timeline | null = null;
  private filePath: string;
  private fileUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private currentContent: string = "";
  private previousContent: string | null = null;
  private highlightCache = new Map<string, string[]>();
  private gitCommitCount = 0;
  private visibleStepsBack = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    filePath: string,
  ) {
    this.filePath = filePath;
    this.fileUri = vscode.Uri.file(filePath);
  }

  async open(viewColumn: vscode.ViewColumn, scrollLine?: number): Promise<void> {
    // Build timeline
    const config = getConfig();
    this.timeline = new Timeline();

    const [commits, localHistory] = await Promise.all([
      getFileHistory(this.filePath, { maxCount: config.maxCommits }),
      config.includeLocalHistory ? getLocalHistory(this.fileUri) : Promise.resolve([]),
    ]);

    this.timeline.build(commits, localHistory, this.filePath);
    this.gitCommitCount = commits.length;

    // Read current file content
    const bytes = await vscode.workspace.fs.readFile(this.fileUri);
    this.currentContent = new TextDecoder().decode(bytes);

    // Create webview panel
    const fileName = this.filePath.split("/").pop() || "file";
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
      light: vscode.Uri.joinPath(this.extensionUri, "media", "icon-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "icon-dark.svg"),
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
    await this.panel.webview.postMessage({
      type: "init",
      highlightedLines,
      language: lang,
      fileName,
      scrollLine: scrollLine ?? 0,
      totalCommits: this.gitCommitCount,
    });
  }

  private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
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
      await this.panel.webview.postMessage({
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
    if (olderEntry?.commitHash) {
      const olderContent = await getFileAtCommit(this.filePath, olderEntry.commitHash);
      if (olderContent !== null) {
        const hlCacheKey = olderEntry.commitHash;
        let highlightedLines = this.highlightCache.get(hlCacheKey);
        if (!highlightedLines) {
          highlightedLines = await highlightCode(olderContent, this.getLanguageId());
          this.highlightCache.set(hlCacheKey, highlightedLines);
        }

        // Compute removed lines: lines in older that don't exist in current
        let diffLines: number[] = [];
        if (currentEntry?.commitHash) {
          const currentContent = await getFileAtCommit(this.filePath, currentEntry.commitHash);
          if (currentContent !== null) {
            diffLines = computeChangedLines(olderContent, currentContent);
          }
        }

        await this.panel.webview.postMessage({
          type: "split-content",
          highlightedLines,
          diffLines,
        });
        return;
      }
    }
    // No older entry — show empty
    await this.panel.webview.postMessage({
      type: "split-content",
      highlightedLines: [],
      diffLines: [],
    });
  }

  private async navigateBack(): Promise<void> {
    if (!this.timeline || !this.panel) return;

    // Skip entries without commitHash (local history without git data)
    let entry = this.timeline.back();
    while (entry && !entry.commitHash) {
      entry = this.timeline.back();
    }
    if (!entry) {
      await this.panel.webview.postMessage({ type: "boundary", direction: "oldest" });
      return;
    }

    this.visibleStepsBack++;
    await this.showEntry(entry);
  }

  private async navigateForward(): Promise<void> {
    if (!this.timeline || !this.panel) return;

    // Skip entries without commitHash
    let entry = this.timeline.forward();
    while (entry && !entry.commitHash) {
      entry = this.timeline.forward();
    }
    if (!entry) {
      // Back at present
      this.visibleStepsBack = 0;
      const highlightedLines = await highlightCode(this.currentContent, this.getLanguageId());
      await this.panel.webview.postMessage({
        type: "content",
        highlightedLines,
        stepsBack: 0,
        info: "Present",
        diffLines: [],
      });
      return;
    }

    this.visibleStepsBack--;
    await this.showEntry(entry);
  }

  private async showEntry(entry: TimelineEntry): Promise<void> {
    if (!entry.commitHash || !this.panel || !this.timeline) return;

    const content = await getFileAtCommit(this.filePath, entry.commitHash);
    if (content === null) {
      await this.panel.webview.postMessage({ type: "boundary", direction: "oldest" });
      return;
    }

    // Get the older entry for diff
    const olderEntry = this.timeline.getOlderEntry();
    let diffLines: number[] = [];
    let deletedRanges: { afterLine: number; lines: string[] }[] = [];
    if (olderEntry?.commitHash) {
      const olderContent = await getFileAtCommit(this.filePath, olderEntry.commitHash);
      if (olderContent !== null) {
        diffLines = computeChangedLines(content, olderContent);
        deletedRanges = computeDeletedPositions(content, olderContent);
      }
    }

    const ago = formatRelativeTime(entry.timestamp);
    const author = entry.authorName ? `@${entry.authorName}` : "";

    // Get blame for changed lines (cached after first fetch)
    let blame: Record<number, string> = {};
    if (diffLines.length > 0 && entry.commitHash) {
      blame = await getBlameForLines(this.filePath, entry.commitHash, diffLines);
    }

    // Highlight the content (cached per commit)
    const hlCacheKey = entry.commitHash || "present";
    let highlightedLines = this.highlightCache.get(hlCacheKey);
    if (!highlightedLines) {
      highlightedLines = await highlightCode(content, this.getLanguageId());
      this.highlightCache.set(hlCacheKey, highlightedLines);
    }

    await this.panel.webview.postMessage({
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
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-editor-font-family, 'Fira Code', 'Cascadia Code', monospace);
      font-size: var(--vscode-editor-font-size, 14px);
      line-height: var(--vscode-editor-line-height, 1.5);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      overflow: hidden;
      height: 100vh;
    }

    #status-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 28px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      color: var(--vscode-foreground, #ccc);
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-size: 12px;
      z-index: 100;
      gap: 10px;
      border-bottom: 1px solid var(--vscode-editorGroup-border, #444);
    }

    #status-bar .position {
      font-weight: 600;
      white-space: nowrap;
    }

    #status-bar .actions {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    #status-bar .actions button {
      background: none;
      border: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-foreground, #ccc);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.1s, border-color 0.1s;
    }

    #status-bar .actions button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }

    #status-bar .actions button.active {
      background: var(--vscode-button-background, #0e639c);
      border-color: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }

    #status-bar .hint {
      margin-left: auto;
      opacity: 0.5;
      font-size: 11px;
      white-space: nowrap;
    }

    #commit-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 24px;
      background: var(--vscode-statusBar-background, #007acc);
      color: var(--vscode-statusBar-foreground, #fff);
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-size: 11px;
      z-index: 100;
      overflow: hidden;
    }

    #commit-bar .message {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    #commit-bar .author {
      margin-left: 12px;
      opacity: 0.8;
      white-space: nowrap;
    }

    #timeline {
      position: fixed;
      top: 28px;
      left: 0;
      right: 0;
      height: 24px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      display: flex;
      align-items: center;
      padding: 0 16px;
      z-index: 99;
      border-bottom: 1px solid var(--vscode-editorGroup-border, #444);
    }

    #timeline-track {
      position: relative;
      flex: 1;
      height: 6px;
      background: var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 3px;
      margin: 0 10px;
      overflow: visible;
    }

    #timeline-progress {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: linear-gradient(90deg, var(--vscode-progressBar-background, #0e70c0), var(--vscode-textLink-foreground, #3794ff));
      border-radius: 3px;
      transition: width 120ms ease-out;
    }

    #timeline-cursor {
      position: absolute;
      top: 50%;
      width: 12px;
      height: 12px;
      background: var(--vscode-editor-foreground, #d4d4d4);
      border: 2px solid var(--vscode-editorGroupHeader-tabsBackground, #252526);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      transition: left 120ms ease-out;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      z-index: 2;
    }

    .timeline-dot {
      position: absolute;
      top: 50%;
      width: 4px;
      height: 4px;
      background: var(--vscode-editorLineNumber-foreground, #858585);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      opacity: 0.5;
    }

    #timeline-label-left,
    #timeline-label-right {
      font-size: 9px;
      color: var(--vscode-descriptionForeground, #888);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    #editors-wrapper {
      position: fixed;
      top: 52px;
      left: 0;
      right: 0;
      bottom: 24px;
      display: flex;
    }

    .editor-pane {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .pane-body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .pane-scroll {
      flex: 1;
      overflow: auto;
      padding: 8px 0;
    }

    .editor-pane + .editor-pane {
      border-left: 1px solid var(--vscode-editorGroup-border, #444);
    }

    .pane-label {
      z-index: 10;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      color: var(--vscode-descriptionForeground, #888);
      font-size: 10px;
      padding: 2px 12px;
      border-bottom: 1px solid var(--vscode-editorGroup-border, #444);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      flex-shrink: 0;
    }

    #split-pane {
      display: none;
    }

    body.split-view #split-pane {
      display: flex;
    }

    #minimap, #minimap-split {
      position: relative;
      width: 14px;
      flex-shrink: 0;
      background: var(--vscode-editorOverviewRuler-background, rgba(0,0,0,0.2));
      z-index: 50;
    }

    #minimap-split {
      display: none;
    }

    body.split-view #minimap-split {
      display: block;
    }

    .minimap-marker-removed {
      position: absolute;
      left: 2px;
      right: 2px;
      min-height: 3px;
      background: var(--vscode-editorOverviewRuler-deletedForeground, #e06c75);
      border-radius: 1px;
      opacity: 0.8;
    }

    .minimap-marker {
      position: absolute;
      left: 2px;
      right: 2px;
      min-height: 3px;
      background: var(--vscode-editorOverviewRuler-modifiedForeground, #66afe0);
      border-radius: 1px;
      opacity: 0.8;
    }

    .code-block {
      counter-reset: line;
      padding: 0;
      min-width: fit-content;
    }

    .line {
      display: flex;
      padding: 0 16px 0 60px;
      position: relative;
      min-height: 1.5em;
      white-space: pre;
      tab-size: 4;
      border-left: 3px solid transparent;
      min-width: 100%;
      box-sizing: border-box;
    }

    .line-content {
      flex: 1 0 auto;
      white-space: pre;
    }

    .line::before {
      content: counter(line);
      counter-increment: line;
      position: absolute;
      left: 3px;
      width: 48px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground, #858585);
      font-size: 0.9em;
      padding-right: 8px;
      user-select: none;
    }

    .line.diff-changed {
      background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.1));
      border-left-color: var(--vscode-editorOverviewRuler-modifiedForeground, #66afe0);
    }

    .line.diff-changed::before {
      color: var(--vscode-editorOverviewRuler-modifiedForeground, #66afe0);
    }

    .line.diff-removed {
      background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.1));
      border-left-color: var(--vscode-editorOverviewRuler-deletedForeground, #e06c75);
    }

    .line.diff-removed::before {
      color: var(--vscode-editorOverviewRuler-deletedForeground, #e06c75);
    }

    .deletion-indicator {
      display: block;
      background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.1));
      border-left: 3px solid var(--vscode-editorOverviewRuler-deletedForeground, #e06c75);
      color: var(--vscode-editor-foreground, #ccc);
      padding: 0 16px 0 60px;
      min-height: 1.5em;
      white-space: pre;
      tab-size: 4;
      opacity: 0.6;
      user-select: none;
      min-width: 100%;
      box-sizing: border-box;
    }

    .blame-annotation {
      position: sticky;
      right: 0;
      font-size: 11px;
      opacity: 0.5;
      color: var(--vscode-editorCodeLens-foreground, #999);
      pointer-events: none;
      white-space: nowrap;
      line-height: inherit;
      padding: 0 8px;
      flex-shrink: 0;
      background: var(--vscode-editor-background, #1e1e1e);
    }

    #boundary-indicator {
      position: fixed;
      bottom: 40px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-notifications-background, #333);
      color: var(--vscode-notifications-foreground, #ccc);
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 12px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      z-index: 200;
    }

    #boundary-indicator.visible {
      opacity: 1;
    }

    .transition {
      animation: fadeIn 150ms ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0.3; }
      to { opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="status-bar">
    <span class="position" id="status-position">Present</span>
    <span class="actions">
      <button id="split-present-btn" title="Compare with present file (Alt+S)">vs Present</button>
      <button id="split-prev-btn" title="Compare with previous commit (Alt+D)">vs Previous</button>
    </span>
    <span class="hint">Alt+Scroll · Escape to exit</span>
  </div>
  <div id="timeline">
    <span id="timeline-label-left">oldest</span>
    <div id="timeline-track">
      <div id="timeline-progress"></div>
      <div id="timeline-cursor" style="left:100%"></div>
    </div>
    <span id="timeline-label-right">now</span>
  </div>
  <div id="editors-wrapper">
    <div class="editor-pane" id="split-pane">
      <div class="pane-label" id="split-label">Present</div>
      <div class="pane-body">
        <div class="pane-scroll" id="split-scroll">
          <div class="code-block" id="code-split"></div>
        </div>
        <div id="minimap-split"></div>
      </div>
    </div>
    <div class="editor-pane" id="history-pane">
      <div class="pane-label" id="history-label" style="display:none">Viewing</div>
      <div class="pane-body">
        <div class="pane-scroll" id="history-scroll">
          <div class="code-block" id="code"></div>
        </div>
        <div id="minimap"></div>
      </div>
    </div>
  </div>
  <div id="commit-bar">
    <span class="message" id="commit-message"></span>
    <span class="author" id="commit-author"></span>
  </div>
  <div id="boundary-indicator">End of history</div>

  <script>
    const vscode = acquireVsCodeApi();
    const codeEl = document.getElementById('code');
    const codeSplitEl = document.getElementById('code-split');
    const statusPosition = document.getElementById('status-position');
    const commitMessage = document.getElementById('commit-message');
    const commitAuthor = document.getElementById('commit-author');
    const historyPane = document.getElementById('history-pane');
    const historyScroll = document.getElementById('history-scroll');
    const splitPane = document.getElementById('split-pane');
    const splitScroll = document.getElementById('split-scroll');
    const historyLabel = document.getElementById('history-label');
    const splitLabel = document.getElementById('split-label');
    const minimapEl = document.getElementById('minimap');
    const minimapSplitEl = document.getElementById('minimap-split');
    const boundaryEl = document.getElementById('boundary-indicator');
    const timelineProgress = document.getElementById('timeline-progress');
    const timelineCursor = document.getElementById('timeline-cursor');
    const timelineTrack = document.getElementById('timeline-track');
    const splitPresentBtn = document.getElementById('split-present-btn');
    const splitPrevBtn = document.getElementById('split-prev-btn');

    let totalCommits = 0;
    let totalLines = 0;
    let lastScrollTime = 0;
    let splitMode = ''; // '', 'present', 'previous'
    const THROTTLE_MS = 60;

    // Split view toggles
    splitPresentBtn.addEventListener('click', () => toggleSplit('present'));
    splitPrevBtn.addEventListener('click', () => toggleSplit('previous'));

    function toggleSplit(mode) {
      if (splitMode === mode) {
        // Turn off
        splitMode = '';
        document.body.classList.remove('split-view');
        splitPresentBtn.classList.remove('active');
        splitPrevBtn.classList.remove('active');
        historyLabel.style.display = 'none';
        syncPaneHeights();
      } else {
        splitMode = mode;
        document.body.classList.add('split-view');
        splitPresentBtn.classList.toggle('active', mode === 'present');
        splitPrevBtn.classList.toggle('active', mode === 'previous');
        historyLabel.style.display = '';

        if (mode === 'present') {
          splitLabel.textContent = 'Present';
          vscode.postMessage({ type: 'request-present' });
        } else {
          splitLabel.textContent = 'Previous commit';
          vscode.postMessage({ type: 'request-previous' });
        }
      }
    }

    // Sync scroll between panes in split mode
    let syncingScroll = false;
    historyScroll.addEventListener('scroll', () => {
      if (splitMode && !syncingScroll) {
        syncingScroll = true;
        splitScroll.scrollTop = historyScroll.scrollTop;
        syncingScroll = false;
      }
    });
    splitScroll.addEventListener('scroll', () => {
      if (splitMode && !syncingScroll) {
        syncingScroll = true;
        historyScroll.scrollTop = splitScroll.scrollTop;
        syncingScroll = false;
      }
    });

    // Wheel event capture for BOTH panes
    function handleWheel(e) {
      if (e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        if (now - lastScrollTime < THROTTLE_MS) return;
        lastScrollTime = now;
        if (e.deltaY > 0) {
          vscode.postMessage({ type: 'scroll-back' });
        } else {
          vscode.postMessage({ type: 'scroll-forward' });
        }
      }
    }
    historyScroll.addEventListener('wheel', handleWheel, { passive: false });
    splitScroll.addEventListener('wheel', handleWheel, { passive: false });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        vscode.postMessage({ type: 'exit' });
      }
      if (e.altKey && e.key === ',') {
        e.preventDefault();
        vscode.postMessage({ type: 'scroll-back' });
      }
      if (e.altKey && e.key === '.') {
        e.preventDefault();
        vscode.postMessage({ type: 'scroll-forward' });
      }
      if (e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        toggleSplit('present');
      }
      if (e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        toggleSplit('previous');
      }
    });

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'init':
          totalCommits = msg.totalCommits || 1;
          renderHighlightedLines(msg.highlightedLines, msg.diffLines || [], msg.blame || {}, msg.deletedRanges || []);
          statusPosition.textContent = msg.fileName + ' \\u00b7 ' + totalCommits + ' commits';
          commitMessage.textContent = '';
          commitAuthor.textContent = '';
          updateTimeline(0);
          renderTimelineDots(totalCommits);
          if (msg.scrollLine > 0) {
            requestAnimationFrame(() => scrollToLine(msg.scrollLine));
          }
          break;

        case 'content': {
          const scrollTop = historyScroll.scrollTop;
          // In split "previous" mode, deletions are already visible in the left pane
          const showDeletions = splitMode !== 'previous' ? (msg.deletedRanges || []) : [];
          renderHighlightedLines(msg.highlightedLines, msg.diffLines || [], msg.blame || {}, showDeletions);
          codeEl.classList.add('transition');
          setTimeout(() => codeEl.classList.remove('transition'), 150);
          if (msg.stepsBack === 0) {
            statusPosition.textContent = 'Present';
            commitMessage.textContent = '';
            commitAuthor.textContent = '';
            updateTimeline(0);
          } else {
            statusPosition.textContent = msg.stepsBack + ' back \\u00b7 ' + msg.ago;
            commitMessage.textContent = msg.commitMessage || '';
            commitAuthor.textContent = msg.author || '';
            updateTimeline(msg.stepsBack);
          }
          // Update split pane if in "previous" mode (it changes with each navigation)
          if (splitMode === 'previous' && msg.previousHighlightedLines) {
            renderSplitLines(msg.previousHighlightedLines);
          }
          requestAnimationFrame(() => { historyScroll.scrollTop = scrollTop; });
          break;
        }

        case 'split-content':
          renderSplitLines(msg.highlightedLines, msg.diffLines || []);
          break;

        case 'boundary':
          showBoundary(msg.direction === 'oldest' ? 'Beginning of file history' : 'At present');
          break;
      }
    });

    let blameData = {};

    function renderHighlightedLines(htmlLines, diffLines, blame, deletedRanges) {
      const diffSet = new Set(diffLines);
      blameData = blame || {};
      totalLines = htmlLines.length;

      const blockStarts = new Set();
      for (let j = 0; j < diffLines.length; j++) {
        if (j === 0 || diffLines[j] !== diffLines[j - 1] + 1) {
          blockStarts.add(diffLines[j]);
        }
      }

      // Build a map of deletion indicators: afterLine -> lines text
      const deletions = new Map();
      if (deletedRanges) {
        for (const r of deletedRanges) {
          const existing = deletions.get(r.afterLine) || [];
          deletions.set(r.afterLine, existing.concat(r.lines));
        }
      }

      let result = '';
      for (let i = 0; i < htmlLines.length; i++) {
        // Insert deleted lines before this line if deletions occurred here
        if (deletions.has(i)) {
          const lines = deletions.get(i);
          for (const line of lines) {
            const escaped = (line || ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            result += '<span class="deletion-indicator">' + escaped + '</span>';
          }
        }

        const diffClass = diffSet.has(i) ? ' diff-changed' : '';
        let blameHtml = '';
        if (blockStarts.has(i) && blameData[i]) {
          blameHtml = '<span class="blame-annotation">' + blameData[i] + '</span>';
        }
        result += '<span class="line' + diffClass + '"><span class="line-content">' + (htmlLines[i] || ' ') + '</span>' + blameHtml + '</span>';
      }
      // Deletion at the very end
      if (deletions.has(htmlLines.length)) {
        const lines = deletions.get(htmlLines.length);
        for (const line of lines) {
          const escaped = (line || ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          result += '<span class="deletion-indicator">' + escaped + '</span>';
        }
      }

      codeEl.innerHTML = result;
      updateMinimap(diffLines, deletedRanges || []);
      if (splitMode) syncPaneHeights();
    }

    function renderSplitLines(htmlLines, diffLines) {
      if (!htmlLines) return;
      const diffSet = new Set(diffLines || []);
      const splitTotalLines = htmlLines.length;
      codeSplitEl.innerHTML = htmlLines.map((lineHtml, i) => {
        const diffClass = diffSet.has(i) ? ' diff-removed' : '';
        return '<span class="line' + diffClass + '">' + (lineHtml || ' ') + '</span>';
      }).join('');

      // Update split minimap with removed lines
      updateSplitMinimap(diffLines || [], splitTotalLines);
      syncPaneHeights();
    }

    function syncPaneHeights() {
      if (!splitMode) {
        codeEl.style.minHeight = '';
        codeSplitEl.style.minHeight = '';
        return;
      }
      // Reset min-heights to measure natural height
      codeEl.style.minHeight = '';
      codeSplitEl.style.minHeight = '';
      const h1 = codeEl.scrollHeight;
      const h2 = codeSplitEl.scrollHeight;
      const maxH = Math.max(h1, h2);
      codeEl.style.minHeight = maxH + 'px';
      codeSplitEl.style.minHeight = maxH + 'px';
    }

    function updateSplitMinimap(diffLines, total) {
      if (!diffLines.length || total === 0) {
        minimapSplitEl.innerHTML = '';
        return;
      }
      const minimapHeight = minimapSplitEl.clientHeight;
      const markers = [];
      let rangeStart = diffLines[0];
      let rangeEnd = diffLines[0];
      for (let i = 1; i <= diffLines.length; i++) {
        if (i < diffLines.length && diffLines[i] === rangeEnd + 1) {
          rangeEnd = diffLines[i];
        } else {
          const top = (rangeStart / total) * minimapHeight;
          const height = Math.max(3, ((rangeEnd - rangeStart + 1) / total) * minimapHeight);
          markers.push('<div class="minimap-marker-removed" style="top:' + top + 'px;height:' + height + 'px"></div>');
          if (i < diffLines.length) {
            rangeStart = diffLines[i];
            rangeEnd = diffLines[i];
          }
        }
      }
      minimapSplitEl.innerHTML = markers.join('');
    }

    function updateMinimap(diffLines, deletedRanges) {
      const minimapHeight = minimapEl.clientHeight;
      const markers = [];

      if (totalLines > 0) {
        // Blue markers for added/changed lines
        if (diffLines.length) {
          let rangeStart = diffLines[0];
          let rangeEnd = diffLines[0];

          for (let i = 1; i <= diffLines.length; i++) {
            if (i < diffLines.length && diffLines[i] === rangeEnd + 1) {
              rangeEnd = diffLines[i];
            } else {
              const top = (rangeStart / totalLines) * minimapHeight;
              const height = Math.max(3, ((rangeEnd - rangeStart + 1) / totalLines) * minimapHeight);
              markers.push('<div class="minimap-marker" style="top:' + top + 'px;height:' + height + 'px"></div>');
              if (i < diffLines.length) {
                rangeStart = diffLines[i];
                rangeEnd = diffLines[i];
              }
            }
          }
        }

        // Red markers for deleted lines
        if (deletedRanges && deletedRanges.length) {
          for (const r of deletedRanges) {
            const top = (r.afterLine / totalLines) * minimapHeight;
            markers.push('<div class="minimap-marker-removed" style="top:' + top + 'px;height:3px"></div>');
          }
        }
      }

      minimapEl.innerHTML = markers.join('');
    }

    function scrollToLine(line) {
      const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || 21;
      historyScroll.scrollTop = line * lineHeight;
    }

    let boundaryTimeout;
    function showBoundary(text) {
      boundaryEl.textContent = text;
      boundaryEl.classList.add('visible');
      clearTimeout(boundaryTimeout);
      boundaryTimeout = setTimeout(() => boundaryEl.classList.remove('visible'), 1500);
    }

    function updateTimeline(stepsBack) {
      if (totalCommits <= 1) {
        timelineProgress.style.width = '100%';
        timelineCursor.style.left = '100%';
        return;
      }
      // stepsBack ranges from 0 (present) to totalCommits (oldest)
      const pct = ((totalCommits - stepsBack) / totalCommits) * 100;
      timelineProgress.style.width = pct + '%';
      timelineCursor.style.left = pct + '%';
    }

    function renderTimelineDots(count) {
      timelineTrack.querySelectorAll('.timeline-dot').forEach(t => t.remove());
      if (count <= 1) return;
      // Show exactly one dot per navigable commit
      // If too many, sample evenly to max 60 dots
      const maxDots = 60;
      const dotsToRender = Math.min(count, maxDots);
      for (let i = 0; i < dotsToRender; i++) {
        // Map dot index to commit index
        const commitIdx = dotsToRender === count ? i : Math.round(i * (count - 1) / (dotsToRender - 1));
        // Use same scale as cursor: position / totalCommits * 100
        // commitIdx 0 = oldest (leftmost), commitIdx count-1 = newest (rightmost)
        const pct = (commitIdx / count) * 100;
        const dot = document.createElement('div');
        dot.className = 'timeline-dot';
        dot.style.left = pct + '%';
        timelineTrack.appendChild(dot);
      }
    }
  </script>
</body>
</html>`;
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
