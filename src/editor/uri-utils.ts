import * as vscode from "vscode";

export const TIMEWARP_SCHEME = "timewarp";

/**
 * Encode a timewarp URI:
 * timewarp:/path/to/file.ts?commit=abc123&label=Fix+bug
 */
export function encodeTimewarpUri(
  filePath: string,
  commitHash: string,
  label?: string,
): vscode.Uri {
  const query = new URLSearchParams({
    commit: commitHash,
    ...(label ? { label } : {}),
  }).toString();

  return vscode.Uri.parse(`${TIMEWARP_SCHEME}:${filePath}?${query}`);
}

export function decodeTimewarpUri(uri: vscode.Uri): {
  filePath: string;
  commitHash: string;
  label?: string;
} | null {
  if (uri.scheme !== TIMEWARP_SCHEME) {
    return null;
  }

  const params = new URLSearchParams(uri.query);
  const commitHash = params.get("commit");

  if (!commitHash) {
    return null;
  }

  return {
    filePath: uri.path,
    commitHash,
    label: params.get("label") ?? undefined,
  };
}
