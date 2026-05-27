import * as vscode from "vscode";
import type { TimelineEntry } from "./types.js";

interface TimelineItemResult {
  timestamp: number;
  label?: string;
  id?: string;
}

export async function getLocalHistory(uri: vscode.Uri): Promise<TimelineEntry[]> {
  try {
    // Use the timeline API via command execution
    const items = await vscode.commands.executeCommand<TimelineItemResult[]>(
      "workbench.timeline.action.loadMore",
      { uri: uri.toString(), source: "timeline.localHistory" },
    );

    if (!items || !Array.isArray(items)) {
      return [];
    }

    return items.map((item) => ({
      id: `local:${item.timestamp}`,
      timestamp: item.timestamp,
      label: item.label || "Local save",
      source: "local-history" as const,
      filePath: uri.fsPath,
    }));
  } catch {
    // Local history API may not be available — this is non-critical
    return [];
  }
}
