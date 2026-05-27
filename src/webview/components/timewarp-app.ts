import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ToWebviewMessage, FromWebviewMessage, DeletedRange, HighlightedLine } from "../messages.js";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface CodeLine {
  tokens: HighlightedLine;
  diffChanged: boolean;
  blameText: string | null;
}

interface SplitLine {
  tokens: HighlightedLine;
  diffRemoved: boolean;
}

interface MinimapMarker {
  topPct: number;
  heightPct: number;
  type: "modified" | "deleted";
}

@customElement("timewarp-app")
export class TimewarpApp extends LitElement {
  private vscode: VsCodeApi = acquireVsCodeApi();

  @state() private totalCommits = 0;
  @state() private totalLines = 0;
  @state() private statusText = "Present";
  @state() private commitMessageText = "";
  @state() private commitAuthorText = "";
  @state() private splitMode: "" | "present" | "previous" = "";
  @state() private mainLines: CodeLine[] = [];
  @state() private mainDeletions = new Map<number, string[]>();
  @state() private splitLines: SplitLine[] = [];
  @state() private splitLabelText = "Present";
  @state() private minimapMarkers: MinimapMarker[] = [];
  @state() private splitMinimapMarkers: MinimapMarker[] = [];
  @state() private boundaryText = "";
  @state() private boundaryVisible = false;
  @state() private timelinePct = 100;
  @state() private timelineDots: number[] = [];

  private lastScrollTime = 0;
  private syncingScroll = false;
  private boundaryTimeout: ReturnType<typeof setTimeout> | undefined;
  private scrollLineOnInit = 0;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this.handleExtensionMessage);
    document.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("message", this.handleExtensionMessage);
    document.removeEventListener("keydown", this.handleKeydown);
  }

  private handleExtensionMessage = (event: MessageEvent<ToWebviewMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "init":
        this.totalCommits = msg.totalCommits || 1;
        this.renderMainCode(msg.highlightedLines, [], {}, []);
        this.statusText = msg.fileName + " \u00b7 " + this.totalCommits + " commits";
        this.commitMessageText = "";
        this.commitAuthorText = "";
        this.timelinePct = 100;
        this.renderTimelineDotPositions(this.totalCommits);
        this.scrollLineOnInit = msg.scrollLine || 0;
        break;

      case "content": {
        const showDeletions = this.splitMode !== "previous" ? (msg.deletedRanges || []) : [];
        this.renderMainCode(msg.highlightedLines, msg.diffLines || [], msg.blame || {}, showDeletions);
        if (msg.stepsBack === 0) {
          this.statusText = "Present";
          this.commitMessageText = "";
          this.commitAuthorText = "";
          this.timelinePct = 100;
        } else {
          this.statusText = msg.stepsBack + " back \u00b7 " + msg.ago;
          this.commitMessageText = msg.commitMessage || "";
          this.commitAuthorText = msg.author || "";
          this.updateTimelinePct(msg.stepsBack);
        }
        break;
      }

      case "split-content":
        this.renderSplitCode(msg.highlightedLines, msg.diffLines || []);
        break;

      case "boundary":
        this.showBoundary(msg.direction === "oldest" ? "Beginning of file history" : "At present");
        break;
    }
  };

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this.postMessage({ type: "exit" });
    }
    if (e.altKey && e.key === ",") {
      e.preventDefault();
      this.postMessage({ type: "scroll-back" });
    }
    if (e.altKey && e.key === ".") {
      e.preventDefault();
      this.postMessage({ type: "scroll-forward" });
    }
    if (e.altKey && e.code === "KeyS") {
      e.preventDefault();
      this.toggleSplit("present");
    }
    if (e.altKey && e.code === "KeyD") {
      e.preventDefault();
      this.toggleSplit("previous");
    }
  };

  private postMessage(msg: FromWebviewMessage) {
    this.vscode.postMessage(msg);
  }

  private handleWheel = (e: WheelEvent) => {
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - this.lastScrollTime < 60) return;
      this.lastScrollTime = now;
      if (e.deltaY > 0) {
        this.postMessage({ type: "scroll-back" });
      } else {
        this.postMessage({ type: "scroll-forward" });
      }
    }
  };

  private toggleSplit(mode: "present" | "previous") {
    if (this.splitMode === mode) {
      this.splitMode = "";
      this.classList.remove("split-view");
    } else {
      this.splitMode = mode;
      this.classList.add("split-view");

      if (mode === "present") {
        this.splitLabelText = "Present";
        this.postMessage({ type: "request-present" });
      } else {
        this.splitLabelText = "Previous commit";
        this.postMessage({ type: "request-previous" });
      }
    }
  }

  private renderMainCode(
    highlightedLines: HighlightedLine[],
    diffLines: number[],
    blame: Record<number, string>,
    deletedRanges: DeletedRange[],
  ) {
    const diffSet = new Set(diffLines);
    this.totalLines = highlightedLines.length;

    const blockStarts = new Set<number>();
    for (let j = 0; j < diffLines.length; j++) {
      if (j === 0 || diffLines[j] !== diffLines[j - 1] + 1) {
        blockStarts.add(diffLines[j]);
      }
    }

    const deletions = new Map<number, string[]>();
    if (deletedRanges) {
      for (const r of deletedRanges) {
        const existing = deletions.get(r.afterLine) || [];
        deletions.set(r.afterLine, existing.concat(r.lines));
      }
    }

    this.mainLines = highlightedLines.map((tokens, i) => ({
      tokens: tokens.length ? tokens : [{ content: " " }],
      diffChanged: diffSet.has(i),
      blameText: (blockStarts.has(i) && blame[i]) ? blame[i] : null,
    }));
    this.mainDeletions = deletions;
    this.computeMinimapMarkers(diffLines, deletedRanges);
    this.syncPaneHeights();
  }

  private renderSplitCode(highlightedLines: HighlightedLine[], diffLines: number[]) {
    if (!highlightedLines) return;
    const diffSet = new Set(diffLines || []);
    this.splitLines = highlightedLines.map((tokens, i) => ({
      tokens: tokens.length ? tokens : [{ content: " " }],
      diffRemoved: diffSet.has(i),
    }));
    this.computeSplitMinimapMarkers(diffLines || [], highlightedLines.length);
    this.syncPaneHeights();
  }

  private syncPaneHeights() {
    if (!this.splitMode) return;
    this.updateComplete.then(() => {
      const codeEl = this.shadowRoot?.getElementById("code");
      const codeSplitEl = this.shadowRoot?.getElementById("code-split");
      if (!codeEl || !codeSplitEl) return;
      codeEl.style.minHeight = "";
      codeSplitEl.style.minHeight = "";
      const h1 = codeEl.scrollHeight;
      const h2 = codeSplitEl.scrollHeight;
      const maxH = Math.max(h1, h2);
      codeEl.style.minHeight = maxH + "px";
      codeSplitEl.style.minHeight = maxH + "px";
    });
  }

  private computeMinimapMarkers(diffLines: number[], deletedRanges: DeletedRange[]) {
    const markers: MinimapMarker[] = [];
    if (this.totalLines > 0) {
      if (diffLines.length) {
        let rangeStart = diffLines[0];
        let rangeEnd = diffLines[0];
        for (let i = 1; i <= diffLines.length; i++) {
          if (i < diffLines.length && diffLines[i] === rangeEnd + 1) {
            rangeEnd = diffLines[i];
          } else {
            markers.push({
              topPct: (rangeStart / this.totalLines) * 100,
              heightPct: ((rangeEnd - rangeStart + 1) / this.totalLines) * 100,
              type: "modified",
            });
            if (i < diffLines.length) {
              rangeStart = diffLines[i];
              rangeEnd = diffLines[i];
            }
          }
        }
      }
      if (deletedRanges && deletedRanges.length) {
        for (const r of deletedRanges) {
          markers.push({
            topPct: (r.afterLine / this.totalLines) * 100,
            heightPct: 0,
            type: "deleted",
          });
        }
      }
    }
    this.minimapMarkers = markers;
  }

  private computeSplitMinimapMarkers(diffLines: number[], total: number) {
    if (!diffLines.length || total === 0) {
      this.splitMinimapMarkers = [];
      return;
    }
    const markers: MinimapMarker[] = [];
    let rangeStart = diffLines[0];
    let rangeEnd = diffLines[0];
    for (let i = 1; i <= diffLines.length; i++) {
      if (i < diffLines.length && diffLines[i] === rangeEnd + 1) {
        rangeEnd = diffLines[i];
      } else {
        markers.push({
          topPct: (rangeStart / total) * 100,
          heightPct: ((rangeEnd - rangeStart + 1) / total) * 100,
          type: "deleted",
        });
        if (i < diffLines.length) {
          rangeStart = diffLines[i];
          rangeEnd = diffLines[i];
        }
      }
    }
    this.splitMinimapMarkers = markers;
  }

  private updateTimelinePct(stepsBack: number) {
    if (this.totalCommits <= 1) {
      this.timelinePct = 100;
      return;
    }
    this.timelinePct = ((this.totalCommits - stepsBack) / this.totalCommits) * 100;
  }

  private renderTimelineDotPositions(count: number) {
    if (count <= 1) {
      this.timelineDots = [];
      return;
    }
    const maxDots = 60;
    const dotsToRender = Math.min(count, maxDots);
    const dots: number[] = [];
    for (let i = 0; i < dotsToRender; i++) {
      const commitIdx = dotsToRender === count ? i : Math.round(i * (count - 1) / (dotsToRender - 1));
      const pct = (commitIdx / count) * 100;
      dots.push(pct);
    }
    this.timelineDots = dots;
  }

  private showBoundary(text: string) {
    this.boundaryText = text;
    this.boundaryVisible = true;
    clearTimeout(this.boundaryTimeout);
    this.boundaryTimeout = setTimeout(() => {
      this.boundaryVisible = false;
    }, 1500);
  }

  private scrollToLine(line: number) {
    const historyScroll = this.shadowRoot?.getElementById("history-scroll");
    if (!historyScroll) return;
    const lineHeight = parseFloat(getComputedStyle(this).lineHeight) || 21;
    historyScroll.scrollTop = line * lineHeight;
  }

  private handleHistoryScroll = () => {
    if (this.splitMode && !this.syncingScroll) {
      this.syncingScroll = true;
      const historyScroll = this.shadowRoot?.getElementById("history-scroll");
      const splitScroll = this.shadowRoot?.getElementById("split-scroll");
      if (historyScroll && splitScroll) {
        splitScroll.scrollTop = historyScroll.scrollTop;
      }
      this.syncingScroll = false;
    }
  };

  private handleSplitScroll = () => {
    if (this.splitMode && !this.syncingScroll) {
      this.syncingScroll = true;
      const historyScroll = this.shadowRoot?.getElementById("history-scroll");
      const splitScroll = this.shadowRoot?.getElementById("split-scroll");
      if (historyScroll && splitScroll) {
        historyScroll.scrollTop = splitScroll.scrollTop;
      }
      this.syncingScroll = false;
    }
  };

  protected updated() {
    if (this.scrollLineOnInit > 0) {
      const line = this.scrollLineOnInit;
      this.scrollLineOnInit = 0;
      requestAnimationFrame(() => this.scrollToLine(line));
    }
  }

  render() {
    return html`
      <div id="status-bar">
        <span class="position">${this.statusText}</span>
        <span class="actions">
          <button
            class=${this.splitMode === "present" ? "active" : ""}
            title="Compare with present file (Alt+S)"
            @click=${() => this.toggleSplit("present")}
          >vs Present</button>
          <button
            class=${this.splitMode === "previous" ? "active" : ""}
            title="Compare with previous commit (Alt+D)"
            @click=${() => this.toggleSplit("previous")}
          >vs Previous</button>
        </span>
        <span class="hint">Alt+Scroll · Escape to exit</span>
      </div>
      <div id="timeline">
        <span id="timeline-label-left">oldest</span>
        <div id="timeline-track">
          <div id="timeline-progress" style="width:${this.timelinePct}%"></div>
          <div id="timeline-cursor" style="left:${this.timelinePct}%"></div>
          ${this.timelineDots.map(
            (pct) => html`<div class="timeline-dot" style="left:${pct}%"></div>`,
          )}
        </div>
        <span id="timeline-label-right">now</span>
      </div>
      <div id="editors-wrapper">
        <div class="editor-pane" id="split-pane">
          <div class="pane-label">${this.splitLabelText}</div>
          <div class="pane-body">
            <div class="pane-scroll" id="split-scroll"
              @wheel=${this.handleWheel}
              @scroll=${this.handleSplitScroll}
            >
              <div class="code-block" id="code-split">${this.renderSplitLines()}</div>
            </div>
            <div class="minimap minimap-split">${this.renderMinimapMarkers(this.splitMinimapMarkers)}</div>
          </div>
        </div>
        <div class="editor-pane" id="history-pane">
          ${this.splitMode ? html`<div class="pane-label">Viewing</div>` : nothing}
          <div class="pane-body">
            <div class="pane-scroll" id="history-scroll"
              @wheel=${this.handleWheel}
              @scroll=${this.handleHistoryScroll}
            >
              <div class="code-block" id="code">${this.renderCodeLines()}</div>
            </div>
            <div class="minimap">${this.renderMinimapMarkers(this.minimapMarkers)}</div>
          </div>
        </div>
      </div>
      <div id="commit-bar">
        <span class="message">${this.commitMessageText}</span>
        <span class="author">${this.commitAuthorText}</span>
      </div>
      <div id="boundary-indicator" class=${this.boundaryVisible ? "visible" : ""}>
        ${this.boundaryText}
      </div>
    `;
  }

  private renderCodeLines(): TemplateResult[] {
    const result: TemplateResult[] = [];
    for (let i = 0; i < this.mainLines.length; i++) {
      const deletedLines = this.mainDeletions.get(i);
      if (deletedLines) {
        for (const line of deletedLines) {
          result.push(html`<span class="deletion-indicator">${line || " "}</span>`);
        }
      }
      const { tokens, diffChanged, blameText } = this.mainLines[i];
      result.push(html`<span class="line ${diffChanged ? "diff-changed" : ""}"><span class="line-content">${this.renderTokens(tokens)}</span>${blameText ? html`<span class="blame-annotation">${blameText}</span>` : nothing}</span>`);
    }
    // Trailing deletions
    const trailingDeletions = this.mainDeletions.get(this.mainLines.length);
    if (trailingDeletions) {
      for (const line of trailingDeletions) {
        result.push(html`<span class="deletion-indicator">${line || " "}</span>`);
      }
    }
    return result;
  }

  private renderSplitLines(): TemplateResult[] {
    return this.splitLines.map(
      ({ tokens, diffRemoved }) =>
        html`<span class="line ${diffRemoved ? "diff-removed" : ""}">${this.renderTokens(tokens)}</span>`,
    );
  }

  private renderTokens(tokens: HighlightedLine): TemplateResult[] {
    return tokens.map((t) =>
      t.color
        ? html`<span style="color:${t.color}">${t.content}</span>`
        : html`${t.content}`,
    );
  }

  private renderMinimapMarkers(markers: MinimapMarker[]): TemplateResult[] {
    return markers.map((m) =>
      html`<div
        class=${m.type === "modified" ? "minimap-marker" : "minimap-marker-removed"}
        style="top:${m.topPct}%;height:${m.heightPct ? `${m.heightPct}%` : "3px"}"
      ></div>`,
    );
  }

    static styles = css`
    :host {
      display: block;
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

    :host(.split-view) #split-pane {
      display: flex;
    }

    .minimap {
      position: relative;
      width: 14px;
      flex-shrink: 0;
      background: var(--vscode-editorOverviewRuler-background, rgba(0,0,0,0.2));
      z-index: 50;
    }

    .minimap-split {
      display: none;
    }

    :host(.split-view) .minimap-split {
      display: block;
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

    .transition {
      animation: fadeIn 150ms ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0.3; }
      to { opacity: 1; }
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
  `;
}
