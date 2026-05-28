import { execFile } from "node:child_process";
import { dirname } from "node:path";
import type { Commit } from "./types.js";

const GIT_LOG_FORMAT = "%H%n%an%n%aI%n%s";
const FIELD_SEPARATOR = "\n";
const FIELDS_PER_COMMIT = 4;

// Cache blame results per commit:filepath to avoid repeated git blame calls
const blameCache = new Map<string, Record<number, string>>();
const BLAME_CACHE_MAX = 50;

export async function getFileHistory(
  filePath: string,
  options?: { maxCount?: number },
): Promise<Commit[]> {
  const maxCount = options?.maxCount ?? 200;

  // --diff-filter=M: only commits that actually modified file content
  // Note: --follow is intentionally omitted because it conflicts with
  // --diff-filter and inflates history with pre-rename commits
  const args = [
    "log",
    `--format=${GIT_LOG_FORMAT}`,
    `--max-count=${maxCount}`,
    "--diff-filter=M",
    "--",
    filePath,
  ];

  const stdout = await execGit(args, filePath);
  if (!stdout.trim()) {
    return [];
  }

  return parseGitLog(stdout);
}

export async function getRepoRoot(filePath: string): Promise<string | null> {
  try {
    const stdout = await execGit(
      ["rev-parse", "--show-toplevel"],
      filePath,
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getBlameForLines(
  filePath: string,
  commitHash: string,
  lines: number[],
): Promise<Record<number, string>> {
  if (lines.length === 0) return {};

  // Check cache
  const cacheKey = `${commitHash}:${filePath}`;
  const cached = blameCache.get(cacheKey);
  if (cached) {
    const result: Record<number, string> = {};
    const lineSet = new Set(lines);
    for (const [line, info] of Object.entries(cached)) {
      const lineNum = parseInt(line, 10);
      if (lineSet.has(lineNum)) {
        result[lineNum] = info;
      }
    }
    return result;
  }

  try {
    const args = [
      "blame",
      "--porcelain",
      commitHash,
      "--",
      filePath,
    ];

    const stdout = await execGit(args, filePath);
    if (!stdout.trim()) return {};

    // Parse porcelain blame output
    // In porcelain format, commit metadata (author, author-time) is only printed
    // the FIRST time a commit hash appears. We must cache it per hash.
    const allBlame: Record<number, string> = {};
    const commitInfo: Map<string, { author: string; timestamp: number }> = new Map();
    const blameLines = stdout.split("\n");

    let currentLine = 0;
    let currentHash = "";
    let author = "";
    let timestamp = 0;

    for (let i = 0; i < blameLines.length; i++) {
      const line = blameLines[i];

      if (/^[0-9a-f]{40} /.test(line)) {
        const parts = line.split(" ");
        currentHash = parts[0];
        currentLine = parseInt(parts[2], 10) - 1; // 0-indexed
        // Restore cached info for this commit if we've seen it before
        const known = commitInfo.get(currentHash);
        if (known) {
          author = known.author;
          timestamp = known.timestamp;
        } else {
          author = "";
          timestamp = 0;
        }
      } else if (line.startsWith("author ")) {
        author = line.slice(7);
      } else if (line.startsWith("author-time ")) {
        timestamp = parseInt(line.slice(12), 10) * 1000;
      } else if (line.startsWith("\t")) {
        // End of this line's metadata block — store commit info and result
        if (author && !commitInfo.has(currentHash)) {
          commitInfo.set(currentHash, { author, timestamp });
        }
        if (author) {
          const ago = formatBlameTime(timestamp);
          allBlame[currentLine] = `${author}, ${ago}`;
        }
      }
    }

    // Cache full blame for this file@commit (with eviction)
    if (blameCache.size >= BLAME_CACHE_MAX) {
      const firstKey = blameCache.keys().next().value;
      if (firstKey) blameCache.delete(firstKey);
    }
    blameCache.set(cacheKey, allBlame);

    // Return only requested lines
    const result: Record<number, string> = {};
    const lineSet = new Set(lines);
    for (const [line, info] of Object.entries(allBlame)) {
      const lineNum = parseInt(line, 10);
      if (lineSet.has(lineNum)) {
        result[lineNum] = info;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function formatBlameTime(timestamp: number): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours > 0) return `${hours}h ago`;
  return "just now";
}

function parseGitLog(output: string): Commit[] {
  const lines = output.trim().split(FIELD_SEPARATOR);
  const commits: Commit[] = [];

  for (let i = 0; i + FIELDS_PER_COMMIT <= lines.length; i += FIELDS_PER_COMMIT) {
    commits.push({
      hash: lines[i],
      authorName: lines[i + 1],
      date: lines[i + 2],
      subject: lines[i + 3],
    });
  }

  return commits;
}

function execGit(args: string[], filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use the directory of the file as cwd (cross-platform path handling)
    const dir = dirname(filePath);

    execFile("git", args, { cwd: dir, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
