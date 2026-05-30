/** A single syntax-highlighted token (content + optional color). */
export interface HighlightToken {
  content: string;
  color?: string;
}

/** A line of highlighted code is an array of tokens. */
export type HighlightedLine = HighlightToken[];

/** Messages sent from the extension host to the webview. */
export type ToWebviewMessage =
  | InitMessage
  | ContentMessage
  | SplitContentMessage
  | BoundaryMessage
  | CommandMessage;

export interface InitMessage {
  type: "init";
  highlightedLines: HighlightedLine[];
  language: string;
  fileName: string;
  scrollLine: number;
  totalCommits: number;
  totalLocalEntries: number;
  /** Restored UI preferences from previous session. */
  timelineMode: TimelineMode;
  splitMode: SplitMode;
  /** Which side the current (history) pane appears on in each split mode. */
  splitPresentLayout: SplitLayout;
  splitPreviousLayout: SplitLayout;
}

export interface ContentMessage {
  type: "content";
  highlightedLines: HighlightedLine[];
  stepsBack: number;
  diffLines: number[];
  ago?: string;
  author?: string;
  commitMessage?: string;
  deletedRanges?: DeletedRange[];
  blame?: Record<number, string>;
  /** Sent when the timeline entry count changes (e.g. mode switch). */
  totalEntries?: number;
}

export interface SplitContentMessage {
  type: "split-content";
  highlightedLines: HighlightedLine[];
  diffLines?: number[];
}

export interface BoundaryMessage {
  type: "boundary";
  direction: "oldest" | "newest";
}

export interface CommandMessage {
  type: "command";
  action: "split-present" | "split-previous" | "scroll-back" | "scroll-forward";
}

/** Messages sent from the webview to the extension host. */
export type FromWebviewMessage =
  | { type: "scroll-back" }
  | { type: "scroll-forward" }
  | { type: "request-present" }
  | { type: "request-previous" }
  | { type: "set-timeline-mode"; mode: TimelineMode }
  | { type: "set-split-mode"; mode: SplitMode }
  | { type: "navigate-to-step"; stepsBack: number }
  | { type: "exit" };

export type TimelineMode = "git" | "local";
export type SplitMode = "" | "present" | "previous";
export type SplitLayout = "current-left" | "current-right";

export interface DeletedRange {
  afterLine: number;
  lines: string[];
}
