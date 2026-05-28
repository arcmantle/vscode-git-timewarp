export interface TimelineEntry {
  id: string;
  timestamp: number; // Unix ms
  label: string;
  source: "git" | "local-history";
  // Git-specific
  commitHash?: string;
  authorName?: string;
  // Local history-specific
  localContentUri?: string; // URI string to the stored content file
  // For content retrieval
  filePath: string;
}
