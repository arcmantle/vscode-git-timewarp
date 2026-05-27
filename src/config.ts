import * as vscode from "vscode";

export interface TimewarpConfig {
  cacheSize: number;
  includeLocalHistory: boolean;
  maxCommits: number;
  debounceMs: number;
}

export function getConfig(): TimewarpConfig {
  const cfg = vscode.workspace.getConfiguration("gitTimewarp");
  return {
    cacheSize: cfg.get("cacheSize", 50),
    includeLocalHistory: cfg.get("includeLocalHistory", true),
    maxCommits: cfg.get("maxCommits", 200),
    debounceMs: cfg.get("debounceMs", 150),
  };
}
