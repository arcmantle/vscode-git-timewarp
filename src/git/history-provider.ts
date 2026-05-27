import { execFile } from "node:child_process";
import type { Commit } from "./types.js";

const GIT_LOG_FORMAT = "%H%n%an%n%aI%n%s";
const FIELD_SEPARATOR = "\n";
const FIELDS_PER_COMMIT = 4;

export async function getFileHistory(
  filePath: string,
  options?: { follow?: boolean; maxCount?: number },
): Promise<Commit[]> {
  const follow = options?.follow ?? true;
  const maxCount = options?.maxCount ?? 200;

  const args = [
    "log",
    `--format=${GIT_LOG_FORMAT}`,
    `--max-count=${maxCount}`,
    ...(follow ? ["--follow"] : []),
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

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use the directory of the file as cwd
    const dir = cwd.includes("/") ? cwd.substring(0, cwd.lastIndexOf("/")) : cwd;

    execFile("git", args, { cwd: dir, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
