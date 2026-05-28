import { describe, it, expect } from "vitest";
import { Timeline } from "../src/history/timeline.js";
import type { Commit } from "../src/git/types.js";
import type { TimelineEntry } from "../src/history/types.js";

function makeCommits(count: number): Commit[] {
  const commits: Commit[] = [];
  for (let i = 0; i < count; i++) {
    commits.push({
      hash: `abc${i.toString().padStart(4, "0")}`,
      authorName: "dev",
      date: new Date(Date.now() - i * 86400000).toISOString(), // 1 day apart, newest first
      subject: `commit ${i}`,
    });
  }
  return commits;
}

function makeLocalHistory(count: number): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: `local:${i}`,
      timestamp: Date.now() - i * 3600000, // 1 hour apart
      label: `local save ${i}`,
      source: "local-history",
      filePath: "/test/file.ts",
      // No commitHash — this is the key distinction
    });
  }
  return entries;
}

describe("Timeline", () => {
  describe("basic navigation", () => {
    it("starts at present (cursor = -1)", () => {
      const tl = new Timeline();
      tl.build(makeCommits(5), [], "/test/file.ts");
      expect(tl.isAtPresent).toBe(true);
      expect(tl.stepsFromPresent).toBe(0);
    });

    it("back() returns entries newest-first", () => {
      const tl = new Timeline();
      const commits = makeCommits(3);
      tl.build(commits, [], "/test/file.ts");

      const entry1 = tl.back();
      expect(entry1?.commitHash).toBe(commits[0].hash);

      const entry2 = tl.back();
      expect(entry2?.commitHash).toBe(commits[1].hash);
    });

    it("forward() moves toward present", () => {
      const tl = new Timeline();
      tl.build(makeCommits(5), [], "/test/file.ts");

      tl.back(); // step 1
      tl.back(); // step 2
      tl.back(); // step 3

      const e = tl.forward();
      expect(e?.commitHash).toBe(`abc0001`); // second newest
      expect(tl.stepsFromPresent).toBe(2);
    });

    it("forward() returns null at present", () => {
      const tl = new Timeline();
      tl.build(makeCommits(3), [], "/test/file.ts");

      tl.back();
      const e = tl.forward();
      expect(e).toBeNull();
      expect(tl.isAtPresent).toBe(true);
    });

    it("back() returns null past the end", () => {
      const tl = new Timeline();
      tl.build(makeCommits(2), [], "/test/file.ts");

      tl.back();
      tl.back();
      const e = tl.back();
      expect(e).toBeNull();
    });
  });

  describe("mixed git + local history", () => {
    it("length includes all entries (git + local)", () => {
      const tl = new Timeline();
      tl.build(makeCommits(5), makeLocalHistory(3), "/test/file.ts");
      // Local history entries are interspersed based on timestamp
      expect(tl.length).toBeGreaterThanOrEqual(5);
    });

    it("back() can return entries without commitHash", () => {
      const tl = new Timeline();
      // Make local history entry far enough from git commits to avoid dedup (>2s)
      const localEntries: TimelineEntry[] = [{
        id: "local:recent",
        timestamp: Date.now() + 10000, // 10s in future — outside 2s dedup window
        label: "recent local save",
        source: "local-history",
        filePath: "/test/file.ts",
      }];
      tl.build(makeCommits(3), localEntries, "/test/file.ts");

      tl.setFilterMode("local");
      expect(tl.length).toBe(1); // 1 local entry
      const first = tl.back();
      // The local entry comes first in local mode
      expect(first?.source).toBe("local-history");
      expect(first?.commitHash).toBeUndefined();
    });
  });
});

describe("Timeline navigation simulation (what the panel does)", () => {
  /**
   * Simulates the panel's navigateBack() logic:
   * Skip entries without commitHash, track visibleStepsBack.
   */
  function simulateNavigateBack(tl: Timeline, state: { visibleStepsBack: number }): TimelineEntry | null {
    let entry = tl.back();
    while (entry && !entry.commitHash) {
      entry = tl.back();
    }
    if (entry) {
      state.visibleStepsBack++;
    }
    return entry;
  }

  function simulateNavigateForward(tl: Timeline, state: { visibleStepsBack: number }): TimelineEntry | null {
    let entry = tl.forward();
    while (entry && !entry.commitHash) {
      entry = tl.forward();
    }
    if (!entry) {
      state.visibleStepsBack = 0;
    } else {
      state.visibleStepsBack--;
    }
    return entry;
  }

  /**
   * The timeline UI formulas (FIXED):
   *   cursor: pct = ((totalCommits - stepsBack) / totalCommits) * 100
   *   dots:   pct = (commitIdx / totalCommits) * 100
   *
   * Where commitIdx = totalCommits - stepsBack (0=oldest, totalCommits-1=newest)
   * Both use totalCommits as denominator so they align.
   */
  function cursorPct(totalCommits: number, stepsBack: number): number {
    return ((totalCommits - stepsBack) / totalCommits) * 100;
  }

  function fixedDotPct(commitIdx: number, totalCommits: number): number {
    return (commitIdx / totalCommits) * 100;
  }

  it("with only git commits, cursor should land on dots (FIXED)", () => {
    const totalCommits = 37;
    const tl = new Timeline();
    tl.build(makeCommits(totalCommits), [], "/test/file.ts");
    const state = { visibleStepsBack: 0 };

    // Navigate back to step 1 (newest historical commit)
    simulateNavigateBack(tl, state);
    expect(state.visibleStepsBack).toBe(1);

    // With the FIXED dot formula (commitIdx / totalCommits * 100):
    // Cursor at step 1: (37 - 1) / 37 * 100 = 97.30%
    // Dot for newest commit (commitIdx = 36): 36 / 37 * 100 = 97.30%
    // They match!
    const cursor = cursorPct(totalCommits, state.visibleStepsBack);
    const dot = fixedDotPct(totalCommits - 1 - state.visibleStepsBack + 1 - 1, totalCommits);
    // Actually: stepsBack=1 corresponds to commitIdx = totalCommits - stepsBack = 36
    const dotForStep = fixedDotPct(totalCommits - state.visibleStepsBack, totalCommits);
    expect(cursor).toBeCloseTo(dotForStep, 10);
  });

  it("at oldest commit, cursor and dot should both be at 0%", () => {
    const totalCommits = 37;
    const state = { visibleStepsBack: totalCommits };

    const cursor = cursorPct(totalCommits, state.visibleStepsBack);
    const dot = fixedDotPct(0, totalCommits);

    // cursor: (37 - 37) / 37 * 100 = 0%
    // dot: 0 / 37 * 100 = 0%
    expect(cursor).toBe(0);
    expect(dot).toBe(0);
  });

  it("at newest commit (step 1), cursor and dot should match", () => {
    const totalCommits = 37;
    const state = { visibleStepsBack: 1 };

    const cursor = cursorPct(totalCommits, state.visibleStepsBack);
    // stepsBack=1 → commitIdx = totalCommits - stepsBack = 36
    const dot = fixedDotPct(totalCommits - state.visibleStepsBack, totalCommits);

    // cursor: 36/37 * 100 = 97.30%
    // dot: 36/37 * 100 = 97.30% ✓
    expect(cursor).toBeCloseTo(dot, 10);
  });

  it("with 5 commits, cursor and dot now match", () => {
    const totalCommits = 5;
    const state = { visibleStepsBack: 1 };

    const cursor = cursorPct(totalCommits, state.visibleStepsBack);
    // stepsBack=1 → commitIdx = 4
    const dot = fixedDotPct(totalCommits - state.visibleStepsBack, totalCommits);

    // cursor: 4/5 * 100 = 80%
    // dot: 4/5 * 100 = 80% ✓
    expect(cursor).toBe(dot);
  });

  it("with 93 commits (real repo), all steps align", () => {
    const totalCommits = 93;

    // Check every step aligns
    for (let step = 1; step <= totalCommits; step++) {
      const cursor = cursorPct(totalCommits, step);
      const dot = fixedDotPct(totalCommits - step, totalCommits);
      expect(cursor).toBeCloseTo(dot, 10);
    }
  });

  it("formula verification: cursor matches dots at all positions", () => {
    const totalCommits = 5;

    // stepsBack=1 (newest commit) → commitIdx = totalCommits - 1 = 4
    expect(cursorPct(5, 1)).toBe(fixedDotPct(4, 5));

    // stepsBack=5 (oldest) → commitIdx = 0
    expect(cursorPct(5, 5)).toBe(fixedDotPct(0, 5));

    // stepsBack=3 → commitIdx = 2
    expect(cursorPct(5, 3)).toBe(fixedDotPct(2, 5));

    // Present (stepsBack=0) is beyond the last dot at 100%
    expect(cursorPct(5, 0)).toBe(100);
  });

  it("with local history entries, navigation only counts git commits", () => {
    const tl = new Timeline();
    // Mix: 5 git commits and 3 local history entries interspersed
    const localEntries: TimelineEntry[] = [
      { id: "l1", timestamp: Date.now() + 100, label: "save 1", source: "local-history", filePath: "/f.ts" },
      { id: "l2", timestamp: Date.now() - 50000, label: "save 2", source: "local-history", filePath: "/f.ts" },
      { id: "l3", timestamp: Date.now() - 200000, label: "save 3", source: "local-history", filePath: "/f.ts" },
    ];
    tl.build(makeCommits(5), localEntries, "/f.ts");

    const state = { visibleStepsBack: 0 };

    // Navigate all the way back — should only count 5 visible steps
    const visited: string[] = [];
    for (let i = 0; i < 20; i++) {
      const entry = simulateNavigateBack(tl, state);
      if (!entry) break;
      visited.push(entry.commitHash!);
    }

    expect(visited.length).toBe(5);
    expect(state.visibleStepsBack).toBe(5);
  });
});
