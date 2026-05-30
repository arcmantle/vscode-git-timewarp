import type { Commit } from "../git/types.js";
import type { TimelineEntry } from "./types.js";

export type TimelineFilterMode = "git" | "local";

export class Timeline {
  private allEntries: TimelineEntry[] = [];
  private entries: TimelineEntry[] = [];
  private cursor = -1; // -1 means "at present"
  private filterMode: TimelineFilterMode = "git";

  get length(): number {
    return this.entries.length;
  }

  get currentIndex(): number {
    return this.cursor;
  }

  get isAtPresent(): boolean {
    return this.cursor === -1;
  }

  get currentEntry(): TimelineEntry | null {
    if (this.cursor < 0 || this.cursor >= this.entries.length) {
      return null;
    }
    return this.entries[this.cursor];
  }

  get stepsFromPresent(): number {
    return this.cursor + 1;
  }

  get gitCount(): number {
    return this.allEntries.filter(e => e.source === "git").length;
  }

  get localCount(): number {
    return this.allEntries.filter(e => e.source === "local-history").length;
  }

  /**
   * Build the timeline from git commits and local history entries.
   * Entries are stored newest-first (index 0 = most recent).
   */
  build(commits: Commit[], localHistory: TimelineEntry[], filePath: string): void {
    const gitEntries: TimelineEntry[] = commits.map((c) => ({
      id: `git:${c.hash}`,
      timestamp: new Date(c.date).getTime(),
      label: c.subject,
      source: "git" as const,
      commitHash: c.hash,
      authorName: c.authorName,
      filePath,
    }));

    const all = [...gitEntries];
    all.sort((a, b) => b.timestamp - a.timestamp);
    this.allEntries = deduplicateByTimestamp(all, 2000);

    // Add any local history entries if provided
    if (localHistory.length > 0) {
      this.addLocalHistory(localHistory);
    }

    this.applyFilter();
  }

  /** Set the timeline filter mode and reset cursor to present. */
  setFilterMode(mode: TimelineFilterMode): void {
    this.filterMode = mode;
    this.applyFilter();
  }

  /** Add local history entries after initial build (lazy load). */
  addLocalHistory(localHistory: TimelineEntry[]): void {
    const newestCommitTime = this.allEntries
      .filter(e => e.source === "git")
      .reduce((max, e) => Math.max(max, e.timestamp), 0);

    const relevant = localHistory.filter(e => e.timestamp > newestCommitTime);
    if (relevant.length === 0) return;

    const merged = [...this.allEntries, ...relevant];
    merged.sort((a, b) => b.timestamp - a.timestamp);
    this.allEntries = deduplicateByTimestamp(merged, 2000);
  }

  private applyFilter(): void {
    if (this.filterMode === "git") {
      this.entries = this.allEntries.filter(e => e.source === "git");
    } else {
      this.entries = this.allEntries.filter(e => e.source === "local-history");
    }
    this.cursor = -1;
  }

  /** Move one step back in time. Returns the entry, or null if at the end. */
  back(): TimelineEntry | null {
    const nextCursor = this.cursor + 1;
    if (nextCursor >= this.entries.length) {
      return null;
    }
    this.cursor = nextCursor;
    return this.entries[this.cursor];
  }

  /** Move one step forward in time (toward present). Returns the entry, or null if at present. */
  forward(): TimelineEntry | null {
    if (this.cursor <= 0) {
      this.cursor = -1;
      return null; // At present
    }
    this.cursor--;
    return this.entries[this.cursor];
  }

  /** Jump back to present. */
  jumpToPresent(): void {
    this.cursor = -1;
  }

  /** Jump directly to a specific position. stepsBack=0 means present. */
  jumpTo(stepsBack: number): TimelineEntry | null {
    if (stepsBack <= 0) {
      this.cursor = -1;
      return null;
    }
    this.cursor = Math.min(stepsBack - 1, this.entries.length - 1);
    return this.entries[this.cursor] ?? null;
  }

  /** Get the entry one step older than the current position (for diff comparison). */
  getOlderEntry(): TimelineEntry | null {
    const olderIdx = this.cursor + 1;
    if (olderIdx >= this.entries.length) {
      return null;
    }
    return this.entries[olderIdx];
  }
}

function deduplicateByTimestamp(entries: TimelineEntry[], windowMs: number): TimelineEntry[] {
  if (entries.length === 0) return [];

  const result: TimelineEntry[] = [entries[0]];

  for (let i = 1; i < entries.length; i++) {
    const prev = result[result.length - 1];
    const curr = entries[i];

    // If within the dedup window and same source, skip
    if (Math.abs(prev.timestamp - curr.timestamp) < windowMs && prev.source !== curr.source) {
      // Prefer git over local-history when they overlap
      if (curr.source === "git") {
        result[result.length - 1] = curr;
      }
      continue;
    }

    // If within window and same source, skip the duplicate
    if (Math.abs(prev.timestamp - curr.timestamp) < windowMs) {
      continue;
    }

    result.push(curr);
  }

  return result;
}
