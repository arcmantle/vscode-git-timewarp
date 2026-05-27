import { execFile } from "node:child_process";
import { LRUCache } from "../cache/lru-cache.js";

const cache = new LRUCache<string, string | null>(50);

export async function getFileAtCommit(
  filePath: string,
  commitHash: string,
): Promise<string | null> {
  const cacheKey = `${commitHash}:${filePath}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const relativePath = await getRelativePath(filePath);
    if (!relativePath) {
      return null;
    }

    const content = await execGit(
      ["show", `${commitHash}:${relativePath}`],
      filePath,
    );

    cache.set(cacheKey, content);
    return content;
  } catch {
    // File didn't exist at this commit, or binary file
    cache.set(cacheKey, null);
    return null;
  }
}

export function clearCache(): void {
  cache.clear();
}

async function getRelativePath(filePath: string): Promise<string | null> {
  try {
    const stdout = await execGit(
      ["ls-files", "--full-name", "--", filePath],
      filePath,
    );
    const result = stdout.trim();
    return result || null;
  } catch {
    return null;
  }
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
