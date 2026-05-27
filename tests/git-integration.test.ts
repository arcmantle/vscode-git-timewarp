import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

/**
 * Integration test against a real git repo to verify our git log flags
 * produce the expected commit count.
 */
describe("git history-provider integration", () => {
  const repoPath = "/Users/roen/Developer/Eyeshare/Flex/es-workflow";
  const testFile = "packages/core/app/framework.ts";

  it("--diff-filter=M without --follow gives ~35 commits for framework.ts", () => {
    const result = execSync(
      `git log --oneline --diff-filter=M -- ${testFile}`,
      { cwd: repoPath, encoding: "utf-8" },
    );
    const count = result.trim().split("\n").filter(Boolean).length;
    // The user confirmed this file has ~35 meaningful commits
    expect(count).toBe(35);
  });

  it("--diff-filter=M with --follow inflates due to renames (not what we want)", () => {
    const result = execSync(
      `git log --oneline --diff-filter=M --follow -- ${testFile}`,
      { cwd: repoPath, encoding: "utf-8" },
    );
    const count = result.trim().split("\n").filter(Boolean).length;
    // With --follow it picks up pre-rename history — much more than 35
    expect(count).toBeGreaterThan(35);
  });

  it("the extension's git log command produces exactly 35", () => {
    // This mirrors exactly what getFileHistory does with follow=false
    const result = execSync(
      `git log --format="%H%n%an%n%aI%n%s%n" --max-count=200 --diff-filter=M -- ${testFile}`,
      { cwd: repoPath, encoding: "utf-8" },
    );
    // Each commit has 4 lines + 1 empty separator = 5 lines per commit
    const lines = result.trim().split("\n").filter(Boolean);
    const commitCount = lines.length / 4;
    expect(commitCount).toBe(35);
  });
});
