import * as vscode from "vscode";

/** Decoration types for diff highlighting */
const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

const removedGutterDecoration = vscode.window.createTextEditorDecorationType({
  gutterIconPath: undefined, // Will use color instead
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

const changedLineDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

/**
 * Apply diff decorations to the editor showing which lines differ
 * between the displayed historical version and the current (HEAD) version.
 */
export function applyDiffDecorations(
  editor: vscode.TextEditor,
  historicalContent: string,
  currentContent: string,
): void {
  const historicalLines = historicalContent.split("\n");
  const currentLines = currentContent.split("\n");

  const diff = computeSimpleDiff(historicalLines, currentLines);

  const addedRanges: vscode.DecorationOptions[] = [];
  const removedRanges: vscode.DecorationOptions[] = [];
  const changedRanges: vscode.DecorationOptions[] = [];

  for (const change of diff) {
    const line = Math.min(change.line, editor.document.lineCount - 1);
    const range = new vscode.Range(line, 0, line, 0);

    if (change.type === "added") {
      // Line exists in historical but not in current → it was removed since then
      addedRanges.push({ range, hoverMessage: "This line was removed in a later version" });
    } else if (change.type === "removed") {
      // Line exists in current but not in historical → it was added later
      removedRanges.push({ range, hoverMessage: "This line does not exist in this version (added later)" });
    } else {
      changedRanges.push({ range, hoverMessage: "This line was modified in a later version" });
    }
  }

  editor.setDecorations(addedLineDecoration, addedRanges);
  editor.setDecorations(removedGutterDecoration, removedRanges);
  editor.setDecorations(changedLineDecoration, changedRanges);
}

/** Clear all diff decorations from an editor */
export function clearDiffDecorations(editor: vscode.TextEditor): void {
  editor.setDecorations(addedLineDecoration, []);
  editor.setDecorations(removedGutterDecoration, []);
  editor.setDecorations(changedLineDecoration, []);
}

interface LineChange {
  line: number;
  type: "added" | "removed" | "changed";
}

/**
 * Simple line-by-line diff between historical and current content.
 * Marks lines in the historical version that differ from current.
 */
function computeSimpleDiff(historicalLines: string[], currentLines: string[]): LineChange[] {
  // Use Myers diff algorithm via LCS to find actually changed lines
  const lcs = computeLCS(historicalLines, currentLines);
  const changes: LineChange[] = [];

  let hi = 0;
  let li = 0;

  for (const match of lcs) {
    // Lines before this match in historical that aren't in current = changed/added
    while (hi < match.histIdx) {
      changes.push({ line: hi, type: "changed" });
      hi++;
    }
    // Skip matching lines
    hi = match.histIdx + 1;
    li = match.currIdx + 1;
  }

  // Remaining lines in historical after last match
  while (hi < historicalLines.length) {
    changes.push({ line: hi, type: "changed" });
    hi++;
  }

  return changes;
}

interface LCSMatch {
  histIdx: number;
  currIdx: number;
}

/**
 * Compute the Longest Common Subsequence between two arrays of lines.
 * Uses a patience-diff-inspired approach: match unique lines first, then fill gaps.
 * Falls back to simple O(n*m) LCS for small files, bounded for large files.
 */
function computeLCS(historical: string[], current: string[]): LCSMatch[] {
  const n = historical.length;
  const m = current.length;

  // For very large files, use a faster heuristic
  if (n * m > 1_000_000) {
    return computeLCSHeuristic(historical, current);
  }

  // Standard O(n*m) LCS with space optimization
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);

  // Build LCS length table
  const table: number[][] = [];
  for (let i = 0; i <= n; i++) {
    table[i] = new Array<number>(m + 1).fill(0);
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (historical[i - 1] === current[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  // Backtrack to find the actual matches
  const matches: LCSMatch[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (historical[i - 1] === current[j - 1]) {
      matches.push({ histIdx: i - 1, currIdx: j - 1 });
      i--;
      j--;
    } else if (table[i - 1][j] > table[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  matches.reverse();
  return matches;
}

/**
 * Heuristic LCS for large files: match lines by their first occurrence.
 * Less accurate but O(n+m) and sufficient for decoration purposes.
 */
function computeLCSHeuristic(historical: string[], current: string[]): LCSMatch[] {
  // Build a map of line content → indices in current
  const currentMap = new Map<string, number[]>();
  for (let j = 0; j < current.length; j++) {
    const line = current[j];
    const indices = currentMap.get(line);
    if (indices) {
      indices.push(j);
    } else {
      currentMap.set(line, [j]);
    }
  }

  // Greedily match historical lines to current lines in order
  const matches: LCSMatch[] = [];
  let lastMatchedJ = -1;

  for (let i = 0; i < historical.length; i++) {
    const indices = currentMap.get(historical[i]);
    if (!indices) continue;

    // Find the first index in current that's after our last match
    const idx = binarySearchFirstGreater(indices, lastMatchedJ);
    if (idx < indices.length) {
      matches.push({ histIdx: i, currIdx: indices[idx] });
      lastMatchedJ = indices[idx];
    }
  }

  return matches;
}

function binarySearchFirstGreater(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function disposeDecorations(): void {
  addedLineDecoration.dispose();
  removedGutterDecoration.dispose();
  changedLineDecoration.dispose();
}
