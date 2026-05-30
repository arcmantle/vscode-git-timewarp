import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ToWebviewMessage, FromWebviewMessage, DeletedRange, HighlightedLine, TimelineMode, SplitLayout } from "../messages.js";

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

interface SearchMatch {
  lineIndex: number;
  charStart: number;
  charEnd: number;
}

interface LineSearchMatch {
  charStart: number;
  charEnd: number;
  globalIdx: number;
}

interface RenderSegment {
  start: number;
  end: number;
  folded: boolean;
}

@customElement("timewarp-app")
export class TimewarpApp extends LitElement {
  private vscode: VsCodeApi = acquireVsCodeApi();

  @state() private totalCommits = 0;
  @state() private totalLocalEntries = 0;
  @state() private timelineMode: TimelineMode = "git";
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
  @state() private timelineNodes: { pct: number; passed: boolean; current: boolean; stepsBack: number }[] = [];

  private splitPresentLayout: SplitLayout = "current-left";
  private splitPreviousLayout: SplitLayout = "current-left";

  @state() private collapseUnchanged = false;
  @state() private ignoreWhitespace = false;
  @state() private expandedFolds: number[] = [];

  @state() private searchVisible = false;
  @state() private searchQuery = "";
  @state() private searchMatches: SearchMatch[] = [];
  @state() private searchCurrentIdx = -1;
  @state() private searchCaseSensitive = false;
  @state() private searchUseRegex = false;
  @state() private searchRegexInvalid = false;

  private searchMatchesByLine = new Map<number, LineSearchMatch[]>();
  private currentStepsBack = 0;

  // Cached data from last content message for re-rendering on mode switch
  private lastHighlightedLines: HighlightedLine[] = [];
  private lastDiffLines: number[] = [];
  private lastBlame: Record<number, string> = {};
  private lastDeletedRanges: DeletedRange[] = [];

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
        this.totalLocalEntries = msg.totalLocalEntries || 0;
        this.timelineMode = msg.timelineMode;
        this.splitPresentLayout = msg.splitPresentLayout ?? "current-left";
        this.splitPreviousLayout = msg.splitPreviousLayout ?? "current-left";
        this.lastHighlightedLines = msg.highlightedLines;
        this.lastDiffLines = [];
        this.lastBlame = {};
        this.lastDeletedRanges = [];
        this.renderMainCode(msg.highlightedLines, [], {}, []);
        this.statusText = msg.fileName + " \u00b7 " + this.totalCommits + " commits";
        this.commitMessageText = "";
        this.commitAuthorText = "";
        this.timelinePct = 100;
        this.currentStepsBack = 0;
        this.renderTimelineNodes(this.totalCommits);
        this.scrollLineOnInit = msg.scrollLine || 0;
        // Restore saved split-pane mode
        if (msg.splitMode) {
          this.toggleSplit(msg.splitMode);
        }
        break;

      case "content": {
        this.lastHighlightedLines = msg.highlightedLines;
        this.lastDiffLines = msg.diffLines || [];
        this.lastBlame = msg.blame || {};
        this.lastDeletedRanges = msg.deletedRanges || [];
        this.expandedFolds = [];
        const showDeletions = this.splitMode !== "previous" ? this.lastDeletedRanges : [];
        this.renderMainCode(msg.highlightedLines, this.lastDiffLines, this.lastBlame, showDeletions);
        if (msg.totalEntries !== undefined) {
          this.totalCommits = msg.totalEntries;
          this.timelinePct = 100;
          this.renderTimelineNodes(this.totalCommits);
          // Mode switched — refresh split pane if open so it doesn't show stale content
          if (this.splitMode) {
            this.postMessage({ type: this.splitMode === "present" ? "request-present" : "request-previous" });
          }
        }
        if (msg.stepsBack === 0) {
          this.statusText = "Present";
          this.commitMessageText = "";
          this.commitAuthorText = "";
          this.timelinePct = 100;
          this.currentStepsBack = 0;
          if (msg.totalEntries === undefined) this.updateCurrentNode();
        } else {
          this.currentStepsBack = msg.stepsBack;
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

      case "command":
        switch (msg.action) {
          case "scroll-back": this.postMessage({ type: "scroll-back" }); break;
          case "scroll-forward": this.postMessage({ type: "scroll-forward" }); break;
          case "split-present": this.toggleSplit("present"); break;
          case "split-previous": this.toggleSplit("previous"); break;
        }
        break;
    }
  };

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (this.searchVisible) {
        this.closeSearch();
      } else {
        this.postMessage({ type: "exit" });
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      this.openSearch();
      return;
    }
    if (e.altKey && e.key === "," && !this.searchVisible) {
      e.preventDefault();
      this.postMessage({ type: "scroll-back" });
    }
    if (e.altKey && e.key === "." && !this.searchVisible) {
      e.preventDefault();
      this.postMessage({ type: "scroll-forward" });
    }
    if (e.altKey && e.code === "KeyS") {
      e.preventDefault();
      if (e.repeat) return;
      this.toggleSplit("present");
    }
    if (e.altKey && e.code === "KeyD") {
      e.preventDefault();
      if (e.repeat) return;
      this.toggleSplit("previous");
    }
  };

  private postMessage(msg: FromWebviewMessage) {
    this.vscode.postMessage(msg);
  }

  private setTimelineMode(mode: TimelineMode) {
    if (this.timelineMode === mode) return;
    this.timelineMode = mode;
    this.postMessage({ type: "set-timeline-mode", mode });
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

  private handleTimelineClick = (e: MouseEvent) => {
    const track = this.shadowRoot?.getElementById("timeline-track");
    if (!track || this.totalCommits <= 0) return;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100));
    const stepsBack = Math.round(this.totalCommits * (1 - pct / 100));
    this.postMessage({ type: "navigate-to-step", stepsBack });
  };

  private toggleSplit(mode: "present" | "previous") {
    if (this.splitMode === mode) {
      this.splitMode = "";
      this.classList.remove("split-view");
      // Re-render main pane to restore deleted overlays
      this.renderMainCode(this.lastHighlightedLines, this.lastDiffLines, this.lastBlame, this.lastDeletedRanges);
      this.postMessage({ type: "set-split-mode", mode: "" });
    } else {
      // If opening split view while at present, step back once so there's an immediate diff
      if (this.currentStepsBack === 0 && this.totalCommits > 1) {
        this.postMessage({ type: "scroll-back" });
      }

      this.splitMode = mode;
      this.classList.add("split-view");

      // Re-render main pane: hide deleted overlays in "previous" mode
      const showDeletions = mode === "previous" ? [] : this.lastDeletedRanges;
      this.renderMainCode(this.lastHighlightedLines, this.lastDiffLines, this.lastBlame, showDeletions);

      if (mode === "present") {
        this.splitLabelText = "Present";
        this.postMessage({ type: "request-present" });
      } else {
        this.splitLabelText = "Previous commit";
        this.postMessage({ type: "request-previous" });
      }
      this.postMessage({ type: "set-split-mode", mode });

      // Sync scroll positions after the DOM updates
      this.updateComplete.then(() => {
        const historyScroll = this.shadowRoot?.getElementById("history-scroll");
        const splitScroll = this.shadowRoot?.getElementById("split-scroll");
        if (historyScroll && splitScroll) {
          splitScroll.scrollTop = historyScroll.scrollTop;
        }
      });
    }
  }

  private getEffectiveDiffLines(): number[] {
    if (!this.ignoreWhitespace || !this.splitLines.length) {
      return this.lastDiffLines;
    }
    return this.lastDiffLines.filter(i => {
      const main = this.mainLines[i]?.tokens.map(t => t.content).join("").replace(/\s+/g, " ").trim();
      const split = this.splitLines[i]?.tokens.map(t => t.content).join("").replace(/\s+/g, " ").trim();
      return main !== split;
    });
  }

  private computeSegments(effectiveDiffLines: number[], totalLines: number): RenderSegment[] {
    if (!this.collapseUnchanged || !effectiveDiffLines.length || totalLines === 0) {
      return totalLines > 0 ? [{ start: 0, end: totalLines - 1, folded: false }] : [];
    }
    const CONTEXT = 3;
    const visibleSet = new Set<number>();
    for (const line of effectiveDiffLines) {
      for (let c = Math.max(0, line - CONTEXT); c <= Math.min(totalLines - 1, line + CONTEXT); c++) {
        visibleSet.add(c);
      }
    }
    const segments: RenderSegment[] = [];
    let segStart = 0;
    let isVisible = visibleSet.has(0);
    for (let i = 1; i < totalLines; i++) {
      const currVisible = visibleSet.has(i);
      if (currVisible !== isVisible) {
        segments.push({ start: segStart, end: i - 1, folded: !isVisible && !this.expandedFolds.includes(segStart) });
        segStart = i;
        isVisible = currVisible;
      }
    }
    segments.push({ start: segStart, end: totalLines - 1, folded: !isVisible && !this.expandedFolds.includes(segStart) });
    return segments;
  }

  private expandFold(startLine: number) {
    this.expandedFolds = [...this.expandedFolds, startLine];
  }

  private toggleCollapseUnchanged() {
    this.collapseUnchanged = !this.collapseUnchanged;
    if (!this.collapseUnchanged) this.expandedFolds = [];
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
    if (this.searchQuery) {
      this.searchCurrentIdx = 0;
      this.computeSearchMatches();
    }
  }

  private renderSplitCode(highlightedLines: HighlightedLine[], diffLines: number[]) {
    if (!highlightedLines) return;
    const diffSet = new Set(diffLines || []);
    this.splitLines = highlightedLines.map((tokens, i) => ({
      tokens: tokens.length ? tokens : [{ content: " " }],
      diffRemoved: diffSet.has(i),
    }));
    this.computeSplitMinimapMarkers(diffLines || [], highlightedLines.length);
    // Sync scroll after split content renders
    this.updateComplete.then(() => {
      const historyScroll = this.shadowRoot?.getElementById("history-scroll");
      const splitScroll = this.shadowRoot?.getElementById("split-scroll");
      if (historyScroll && splitScroll) {
        splitScroll.scrollTop = historyScroll.scrollTop;
      }
    });
  }

  private syncPaneHeights() {
    if (!this.splitMode) return;
    requestAnimationFrame(() => {
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
    this.updateCurrentNode();
  }

  private renderTimelineNodes(count: number) {
    if (count < 1) {
      this.timelineNodes = [];
      return;
    }
    // count entries + 1 "present" position = count+1 total stops
    const totalStops = count + 1;
    const maxNodes = 40;
    const nodesToRender = Math.min(totalStops, maxNodes);
    const nodes: { pct: number; passed: boolean; current: boolean }[] = [];
    for (let i = 0; i < nodesToRender; i++) {
      const stopIdx = nodesToRender === totalStops
        ? i
        : Math.round(i * count / (nodesToRender - 1));
      const pct = (stopIdx / count) * 100;
      nodes.push({ pct, passed: pct <= this.timelinePct, current: false, stepsBack: count - stopIdx });
    }
    this.timelineNodes = nodes;
    this.updateCurrentNode();
  }

  private updateCurrentNode() {
    // Mark the node closest to timelinePct as "current"
    let closestIdx = -1;
    let closestDist = Infinity;
    for (let i = 0; i < this.timelineNodes.length; i++) {
      const dist = Math.abs(this.timelineNodes[i].pct - this.timelinePct);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }
    this.timelineNodes = this.timelineNodes.map((n, i) => ({
      ...n,
      passed: n.pct <= this.timelinePct,
      current: i === closestIdx,
    }));
  }

  private showBoundary(text: string) {
    this.boundaryText = text;
    this.boundaryVisible = true;
    clearTimeout(this.boundaryTimeout);
    this.boundaryTimeout = setTimeout(() => {
      this.boundaryVisible = false;
    }, 1500);
  }

  private scrollToLine(line: number, center = false) {
    const historyScroll = this.shadowRoot?.getElementById("history-scroll");
    if (!historyScroll) return;
    const lineHeight = parseFloat(getComputedStyle(this).lineHeight) || 21;
    const offset = line * lineHeight;
    if (center) {
      historyScroll.scrollTop = offset - historyScroll.clientHeight / 2 + lineHeight / 2;
    } else {
      historyScroll.scrollTop = offset;
    }
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
    this.syncPaneHeights();
  }

  private openSearch() {
    this.searchVisible = true;
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.getElementById("search-input") as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private closeSearch() {
    this.searchVisible = false;
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchCurrentIdx = -1;
    this.searchMatchesByLine.clear();
  }

  private buildSearchRegex(): RegExp | null {
    if (!this.searchQuery) return null;
    try {
      const pattern = this.searchUseRegex
        ? this.searchQuery
        : this.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const flags = this.searchCaseSensitive ? "g" : "gi";
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  }

  private computeSearchMatches() {
    if (!this.searchQuery) {
      this.searchMatches = [];
      this.searchCurrentIdx = -1;
      this.searchMatchesByLine.clear();
      this.searchRegexInvalid = false;
      return;
    }
    const regex = this.buildSearchRegex();
    if (!regex) {
      this.searchRegexInvalid = this.searchUseRegex;
      this.searchMatches = [];
      this.searchCurrentIdx = -1;
      this.searchMatchesByLine.clear();
      return;
    }
    this.searchRegexInvalid = false;
    const matches: SearchMatch[] = [];
    const byLine = new Map<number, LineSearchMatch[]>();
    for (let i = 0; i < this.mainLines.length; i++) {
      const lineText = this.mainLines[i].tokens.map(t => t.content).join("");
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(lineText)) !== null) {
        if (m[0].length === 0) { regex.lastIndex++; continue; }
        const charStart = m.index;
        const charEnd = charStart + m[0].length;
        const globalIdx = matches.length;
        matches.push({ lineIndex: i, charStart, charEnd });
        const arr = byLine.get(i) ?? [];
        arr.push({ charStart, charEnd, globalIdx });
        byLine.set(i, arr);
      }
    }
    this.searchMatchesByLine = byLine;
    this.searchMatches = matches;
    if (matches.length === 0) {
      this.searchCurrentIdx = -1;
    } else if (this.searchCurrentIdx < 0) {
      this.searchCurrentIdx = 0;
    } else {
      this.searchCurrentIdx = Math.min(this.searchCurrentIdx, matches.length - 1);
    }
  }

  private toggleSearchCaseSensitive() {
    this.searchCaseSensitive = !this.searchCaseSensitive;
    this.computeSearchMatches();
    if (this.searchMatches.length > 0) this.scrollToMatch(this.searchCurrentIdx);
  }

  private toggleSearchRegex() {
    this.searchUseRegex = !this.searchUseRegex;
    this.computeSearchMatches();
    if (this.searchMatches.length > 0) this.scrollToMatch(this.searchCurrentIdx);
  }

  private handleSearchInput = (e: Event) => {
    this.searchQuery = (e.target as HTMLInputElement).value;
    this.searchCurrentIdx = 0;
    this.computeSearchMatches();
    if (this.searchMatches.length > 0) {
      this.scrollToMatch(0);
    }
  };

  private handleSearchKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        this.searchPrev();
      } else {
        this.searchNext();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.closeSearch();
    }
  };

  private searchNext() {
    if (this.searchMatches.length === 0) return;
    this.searchCurrentIdx = (this.searchCurrentIdx + 1) % this.searchMatches.length;
    this.scrollToMatch(this.searchCurrentIdx);
  }

  private searchPrev() {
    if (this.searchMatches.length === 0) return;
    this.searchCurrentIdx = (this.searchCurrentIdx - 1 + this.searchMatches.length) % this.searchMatches.length;
    this.scrollToMatch(this.searchCurrentIdx);
  }

  private scrollToMatch(idx: number) {
    const match = this.searchMatches[idx];
    if (match) this.scrollToLine(match.lineIndex, true);
  }

  render() {
    return html`
      <div id="status-bar">
        <span class="position">${this.statusText}</span>
        <span class="timeline-toggle">
          <button
            class=${this.timelineMode === "git" ? "active" : ""}
            title="Show git commits only"
            @click=${() => this.setTimelineMode("git")}
          >⎇ Git</button>
          <button
            class=${this.timelineMode === "local" ? "active" : ""}
            title="Show local saves only"
            @click=${() => this.setTimelineMode("local")}
          >⟳ Local</button>
        </span>
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
        <span class="view-options">
          <button
            class=${this.collapseUnchanged ? "active" : ""}
            title="Collapse unchanged regions"
            @click=${() => this.toggleCollapseUnchanged()}
          >⋟ Collapse</button>
          <button
            class=${this.ignoreWhitespace ? "active" : ""}
            title="Ignore whitespace changes"
            @click=${() => { this.ignoreWhitespace = !this.ignoreWhitespace; }}
          >⎵ Whitespace</button>
        </span>
        <span class="hint">Alt+,/. · Alt+Scroll · Ctrl+F · Escape to exit</span>
      </div>
      <div id="timeline">
        <span id="timeline-label-left">oldest</span>
        <div id="timeline-track" @click=${this.handleTimelineClick}>
          <div id="timeline-line"></div>
          <div id="timeline-line-progress" style="width:${this.timelinePct}%"></div>
          ${this.timelineNodes.map(
            (node) => html`<div class="timeline-node ${node.passed ? "passed" : ""} ${node.current ? "current" : ""}" style="left:${node.pct}%" @click=${(e: Event) => { e.stopPropagation(); this.postMessage({ type: "navigate-to-step", stepsBack: node.stepsBack }); }}></div>`,
          )}
        </div>
        <span id="timeline-label-right">now</span>
      </div>
      <div id="editors-wrapper">
        ${this.renderPanes()}
      </div>
      <div id="commit-bar">
        <span class="message">${this.commitMessageText}</span>
        <span class="author">${this.commitAuthorText}</span>
      </div>
      <div id="boundary-indicator" class=${this.boundaryVisible ? "visible" : ""}>
        ${this.boundaryText}
      </div>
      ${this.searchVisible ? html`
        <div id="search-bar">
          <div class="search-input-group ${this.searchRegexInvalid ? 'invalid' : ''}">
            <input
              id="search-input"
              type="text"
              placeholder="Find..."
              autocomplete="off"
              spellcheck="false"
              .value=${this.searchQuery}
              @input=${this.handleSearchInput}
              @keydown=${this.handleSearchKeydown}
            />
            <button
              class="option-btn ${this.searchCaseSensitive ? 'active' : ''}"
              title="Match Case"
              @click=${() => this.toggleSearchCaseSensitive()}
            >Aa</button>
            <button
              class="option-btn ${this.searchUseRegex ? 'active' : ''}"
              title="Use Regular Expression"
              @click=${() => this.toggleSearchRegex()}
            >.*</button>
          </div>
          <span class="search-count ${this.searchQuery && this.searchMatches.length === 0 && !this.searchRegexInvalid ? 'no-results' : ''} ${this.searchRegexInvalid ? 'invalid-regex' : ''}">
            ${this.searchRegexInvalid
              ? "Invalid regex"
              : this.searchMatches.length > 0
                ? `${this.searchCurrentIdx + 1} of ${this.searchMatches.length}`
                : this.searchQuery ? "No results" : ""}
          </span>
          <div class="search-nav-group">
            <button @click=${this.searchPrev} title="Previous match (Shift+Enter)">↑</button>
            <button @click=${this.searchNext} title="Next match (Enter)">↓</button>
          </div>
          <button class="search-close" @click=${this.closeSearch} title="Close (Escape)">✕</button>
        </div>
      ` : nothing}
    `;
  }

  private renderPanes(): TemplateResult {
    const layout = this.splitMode === "previous"
      ? this.splitPreviousLayout
      : this.splitPresentLayout;
    const currentLeft = !this.splitMode || layout === "current-left";

    const effectiveDiffLines = this.getEffectiveDiffLines();
    const effectiveDiffSet = new Set(effectiveDiffLines);
    const segments = this.computeSegments(effectiveDiffLines, this.mainLines.length);

    // Build effective split diff set: filter diffRemoved by whitespace when needed
    const effectiveSplitDiffSet = new Set(
      this.splitLines
        .map((l, i) => l.diffRemoved ? i : -1)
        .filter(i => {
          if (i < 0) return false;
          if (!this.ignoreWhitespace) return true;
          const splitText = this.splitLines[i].tokens.map(t => t.content).join("").replace(/\s+/g, " ").trim();
          const mainText = this.mainLines[i]?.tokens.map(t => t.content).join("").replace(/\s+/g, " ").trim();
          return splitText !== mainText;
        })
    );
    const historyPane = html`
      <div class="editor-pane" id="history-pane">
        ${this.splitMode ? html`<div class="pane-label">Viewing</div>` : nothing}
        <div class="pane-body">
          <div class="pane-scroll" id="history-scroll"
            @wheel=${this.handleWheel}
            @scroll=${this.handleHistoryScroll}
          >
            <div class="code-block" id="code">${this.renderCodeLines(segments, effectiveDiffSet)}</div>
          </div>
          <div class="minimap">${this.renderMinimapMarkers(this.minimapMarkers)}</div>
        </div>
      </div>`;

    const splitPane = html`
      <div class="editor-pane" id="split-pane">
        <div class="pane-label">${this.splitLabelText}</div>
        <div class="pane-body">
          <div class="pane-scroll" id="split-scroll"
            @wheel=${this.handleWheel}
            @scroll=${this.handleSplitScroll}
          >
            <div class="code-block" id="code-split">${this.renderSplitLines(segments, effectiveSplitDiffSet)}</div>
          </div>
          <div class="minimap minimap-split">${this.renderMinimapMarkers(this.splitMinimapMarkers)}</div>
        </div>
      </div>`;

    return currentLeft
      ? html`${historyPane}${splitPane}`
      : html`${splitPane}${historyPane}`;
  }

  private renderCodeLines(segments: RenderSegment[], effectiveDiffSet: Set<number>): TemplateResult[] {
    const result: TemplateResult[] = [];
    const foldedLines = new Set<number>();
    for (const seg of segments) {
      if (seg.folded) {
        for (let i = seg.start; i <= seg.end; i++) foldedLines.add(i);
      }
    }
    for (const seg of segments) {
      if (seg.folded) {
        result.push(html`<div class="fold-bar" @click=${() => this.expandFold(seg.start)}>↕ ${seg.end - seg.start + 1} unchanged line${seg.end - seg.start > 0 ? "s" : ""}</div>`);
        continue;
      }
      for (let i = seg.start; i <= seg.end; i++) {
        const deletedLines = this.mainDeletions.get(i);
        if (deletedLines) {
          for (const line of deletedLines) {
            result.push(html`<span class="deletion-indicator">${line || " "}</span>`);
          }
        }
        if (i >= this.mainLines.length) continue;
        const { tokens, blameText } = this.mainLines[i];
        const diffChanged = effectiveDiffSet.has(i);
        const lineSearchMatches = this.searchMatchesByLine.get(i);
        const renderedTokens = lineSearchMatches
          ? this.renderTokensWithSearch(tokens, lineSearchMatches)
          : this.renderTokens(tokens);
        result.push(html`<span class="line ${diffChanged ? "diff-changed" : ""}" data-line="${i + 1}"><span class="line-content">${renderedTokens}</span>${blameText ? html`<span class="blame-annotation">${blameText}</span>` : nothing}</span>`);
      }
    }
    // Trailing deletions (only if last line is visible)
    if (!foldedLines.has(this.mainLines.length - 1)) {
      const trailingDeletions = this.mainDeletions.get(this.mainLines.length);
      if (trailingDeletions) {
        for (const line of trailingDeletions) {
          result.push(html`<span class="deletion-indicator">${line || " "}</span>`);
        }
      }
    }
    return result;
  }

  private renderSplitLines(segments: RenderSegment[], effectiveSplitDiffSet: Set<number>): TemplateResult[] {
    const result: TemplateResult[] = [];
    for (const seg of segments) {
      if (seg.folded) {
        result.push(html`<div class="fold-bar inert">\u2195 ${seg.end - seg.start + 1} unchanged line${seg.end - seg.start > 0 ? "s" : ""}</div>`);
        continue;
      }
      for (let i = seg.start; i <= seg.end; i++) {
        if (i >= this.splitLines.length) {
          result.push(html`<span class="line"> </span>`);
          continue;
        }
        const { tokens } = this.splitLines[i];
        const diffRemoved = effectiveSplitDiffSet.has(i);
        result.push(html`<span class="line ${diffRemoved ? "diff-removed" : ""}" data-line="${i + 1}">${this.renderTokens(tokens)}</span>`);
      }
    }
    return result;
  }

  private renderTokens(tokens: HighlightedLine): TemplateResult[] {
    return tokens.map((t) =>
      t.color
        ? html`<span style="color:${t.color}">${t.content}</span>`
        : html`${t.content}`,
    );
  }

  private renderTokensWithSearch(tokens: HighlightedLine, lineMatches: LineSearchMatch[]): TemplateResult[] {
    const result: TemplateResult[] = [];
    const breakpoints = new Set<number>();
    for (const m of lineMatches) {
      breakpoints.add(m.charStart);
      breakpoints.add(m.charEnd);
    }
    const isMatchAt = (pos: number): { isMatch: boolean; isCurrent: boolean } => {
      for (const m of lineMatches) {
        if (pos >= m.charStart && pos < m.charEnd) {
          return { isMatch: true, isCurrent: m.globalIdx === this.searchCurrentIdx };
        }
      }
      return { isMatch: false, isCurrent: false };
    };
    let charPos = 0;
    for (const token of tokens) {
      let tokenPos = 0;
      while (tokenPos < token.content.length) {
        const absPos = charPos + tokenPos;
        let nextBreak = token.content.length;
        for (const bp of breakpoints) {
          const rel = bp - charPos;
          if (rel > tokenPos && rel < nextBreak) nextBreak = rel;
        }
        const chunk = token.content.slice(tokenPos, nextBreak);
        const { isMatch, isCurrent } = isMatchAt(absPos);
        if (isMatch) {
          result.push(token.color
            ? html`<span class="search-match ${isCurrent ? "current" : ""}" style="color:${token.color}">${chunk}</span>`
            : html`<span class="search-match ${isCurrent ? "current" : ""}">${chunk}</span>`);
        } else {
          result.push(token.color
            ? html`<span style="color:${token.color}">${chunk}</span>`
            : html`${chunk}`);
        }
        tokenPos = nextBreak;
      }
      charPos += token.content.length;
    }
    return result;
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

    .timeline-toggle {
      display: flex;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--vscode-button-border, #555);
    }

    .timeline-toggle button {
      background: none;
      border: none;
      border-right: 1px solid var(--vscode-button-border, #555);
      color: var(--vscode-foreground, #ccc);
      font-size: 11px;
      padding: 2px 8px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.1s, color 0.1s;
    }

    .timeline-toggle button:last-child {
      border-right: none;
    }

    .timeline-toggle button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }

    .timeline-toggle button.active {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
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

    #status-bar .view-options {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    #status-bar .view-options button {
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

    #status-bar .view-options button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }

    #status-bar .view-options button.active {
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
      height: 32px;
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
      height: 32px;
      margin: 0 10px;
      display: flex;
      align-items: center;
      overflow: visible;
      cursor: pointer;
    }

    #timeline-line {
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--vscode-editorWidget-border, #3c3c3c);
      transform: translateY(-50%);
    }

    #timeline-line-progress {
      position: absolute;
      top: 50%;
      left: 0;
      height: 2px;
      background: var(--vscode-textLink-foreground, #3794ff);
      transform: translateY(-50%);
      transition: width 120ms ease-out;
    }

    .timeline-node {
      position: absolute;
      top: 50%;
      width: 8px;
      height: 8px;
      background: var(--vscode-editorWidget-border, #3c3c3c);
      border: 2px solid var(--vscode-editorWidget-border, #3c3c3c);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      transition: all 120ms ease-out;
      z-index: 1;
      cursor: pointer;
    }

    .timeline-node:hover {
      transform: translate(-50%, -50%) scale(1.5);
    }

    .timeline-node.passed {
      background: var(--vscode-textLink-foreground, #3794ff);
      border-color: var(--vscode-textLink-foreground, #3794ff);
    }

    .timeline-node.current {
      width: 14px;
      height: 14px;
      background: var(--vscode-editor-foreground, #d4d4d4);
      border-color: var(--vscode-textLink-foreground, #3794ff);
      box-shadow: 0 0 8px rgba(55, 148, 255, 0.6);
      z-index: 2;
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
      top: 60px;
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
      content: attr(data-line);
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
      user-select: none;
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

    .fold-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 20px;
      background: var(--vscode-diffEditor-unchangedRegionBackground, rgba(0,0,0,0.2));
      color: var(--vscode-descriptionForeground, #888);
      font-size: 11px;
      cursor: pointer;
      user-select: none;
      border-top: 1px solid var(--vscode-editorGroup-border, #333);
      border-bottom: 1px solid var(--vscode-editorGroup-border, #333);
      white-space: nowrap;
      min-width: 100%;
      box-sizing: border-box;
    }

    .fold-bar:hover:not(.inert) {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
      color: var(--vscode-foreground, #ccc);
    }

    .fold-bar.inert {
      cursor: default;
      pointer-events: none;
    }

    #search-bar {
      position: fixed;
      top: 62px;
      right: 22px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 0;
      padding: 3px 4px;
      z-index: 150;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }

    .search-input-group {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding-right: 2px;
    }

    .search-input-group:focus-within {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .search-input-group.invalid {
      border-color: var(--vscode-inputValidation-errorBorder, #be1100);
    }

    #search-input {
      background: transparent;
      color: var(--vscode-input-foreground, #cccccc);
      border: none;
      padding: 3px 6px;
      font-size: 13px;
      font-family: var(--vscode-editor-font-family, monospace);
      width: 200px;
      outline: none;
    }

    .search-nav-group {
      display: flex;
      align-items: center;
      margin-left: 2px;
    }

    .search-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      white-space: nowrap;
      min-width: 64px;
      text-align: center;
      padding: 0 4px;
    }

    .search-count.no-results {
      color: var(--vscode-inputValidation-errorForeground, #f48771);
    }

    .search-count.invalid-regex {
      color: var(--vscode-inputValidation-errorForeground, #f48771);
    }

    #search-bar button {
      background: none;
      border: 1px solid transparent;
      color: var(--vscode-foreground, #ccc);
      cursor: pointer;
      padding: 0;
      border-radius: 3px;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      line-height: 1;
      flex-shrink: 0;
    }

    #search-bar button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
      border-color: var(--vscode-toolbar-hoverBackground, transparent);
    }

    .search-close {
      margin-left: 2px;
    }

    .option-btn {
      font-size: 10px !important;
      font-family: var(--vscode-editor-font-family, monospace);
      letter-spacing: -0.5px;
    }

    .option-btn.active {
      background: var(--vscode-inputOption-activeBackground, rgba(0, 127, 212, 0.4)) !important;
      border-color: var(--vscode-inputOption-activeBorder, #007fd4) !important;
      color: var(--vscode-inputOption-activeForeground, #ffffff) !important;
    }

    .search-match {
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 198, 0, 0.3));
      border-radius: 2px;
      outline: 1px solid var(--vscode-editor-findMatchHighlightBorder, transparent);
      outline-offset: -1px;
    }

    .search-match.current {
      background: var(--vscode-editor-findMatchBackground, rgba(255, 140, 0, 0.65));
      outline-color: var(--vscode-editor-findMatchBorder, #d2b100);
    }
  `;
}
