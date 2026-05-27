export interface TimelineEntry {
  id: string;
  timestamp: number; // Unix ms
  label: string;
  source: "git" | "local-history";
  // Git-specific
  commitHash?: string;
  authorName?: string;
  // For content retrieval
  filePath: string;
}
