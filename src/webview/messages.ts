/** Messages sent from the extension host to the webview. */
export type ToWebviewMessage =
  | InitMessage
  | ContentMessage
  | SplitContentMessage
  | BoundaryMessage;

export interface InitMessage {
  type: "init";
  highlightedLines: string[];
  language: string;
  fileName: string;
  scrollLine: number;
  totalCommits: number;
}

export interface ContentMessage {
  type: "content";
  highlightedLines: string[];
  stepsBack: number;
  diffLines: number[];
  ago?: string;
  author?: string;
  commitMessage?: string;
  deletedRanges?: DeletedRange[];
  blame?: Record<number, string>;
}

export interface SplitContentMessage {
  type: "split-content";
  highlightedLines: string[];
  diffLines?: number[];
}

export interface BoundaryMessage {
  type: "boundary";
  direction: "oldest" | "newest";
}

/** Messages sent from the webview to the extension host. */
export type FromWebviewMessage =
  | { type: "scroll-back" }
  | { type: "scroll-forward" }
  | { type: "request-present" }
  | { type: "request-previous" }
  | { type: "exit" };

export interface DeletedRange {
  afterLine: number;
  lines: string[];
}
