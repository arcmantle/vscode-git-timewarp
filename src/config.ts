import * as vscode from "vscode";

export type SplitLayout = "current-left" | "current-right";

export interface TimewarpConfig {
  cacheSize: number;
  includeLocalHistory: boolean;
  maxCommits: number;
  debounceMs: number;
  splitPresentLayout: SplitLayout;
  splitPreviousLayout: SplitLayout;
}

export function getConfig(): TimewarpConfig {
  const cfg = vscode.workspace.getConfiguration("gitTimewarp");
  return {
    cacheSize: cfg.get("cacheSize", 50),
    includeLocalHistory: cfg.get("includeLocalHistory", true),
    maxCommits: cfg.get("maxCommits", 200),
    debounceMs: cfg.get("debounceMs", 150),
    splitPresentLayout: cfg.get("splitPresentLayout", "current-left"),
    splitPreviousLayout: cfg.get("splitPreviousLayout", "current-left"),
  };
}
