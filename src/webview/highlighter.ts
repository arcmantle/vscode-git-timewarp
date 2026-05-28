import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import type { HighlightedLine } from "./messages.js";

let highlighterInstance: Highlighter | null = null;
let loadedThemeSetting: string | null = null;
let loadedShikiThemeName: string | null = null;
let highlighterPromise: Promise<{ highlighter: Highlighter; themeName: string }> | null = null;

const SUPPORTED_LANGUAGES: BundledLanguage[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "css",
  "scss",
  "html",
  "vue",
  "svelte",
  "python",
  "rust",
  "go",
  "ruby",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "bash",
  "yaml",
  "toml",
  "xml",
  "sql",
  "graphql",
  "dockerfile",
];

/**
 * Attempt to find and load the user's active VS Code theme JSON from the extensions directory.
 */
async function loadUserTheme(): Promise<Record<string, unknown> | null> {
  const themeName = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
  if (!themeName) return null;

  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes;
    if (!themes || !Array.isArray(themes)) continue;

    for (const theme of themes) {
      if (theme.label === themeName || theme.id === themeName) {
        const themePath = path.join(ext.extensionPath, theme.path);
        try {
          const raw = await fs.readFile(themePath, "utf8");
          const themeJson = JSON.parse(raw);

          // Ensure it has a name
          if (!themeJson.name) {
            themeJson.name = themeName;
          }

          // Set type based on active theme kind
          const kind = vscode.window.activeColorTheme.kind;
          if (!themeJson.type) {
            themeJson.type = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
              ? "dark"
              : "light";
          }

          // Resolve include if present (theme inheritance)
          if (themeJson.include) {
            const includePath = path.resolve(path.dirname(themePath), themeJson.include);
            try {
              const includeRaw = await fs.readFile(includePath, "utf8");
              const includeJson = JSON.parse(includeRaw);
              // Merge: base theme provides defaults, current theme overrides
              themeJson.tokenColors = [
                ...(includeJson.tokenColors || []),
                ...(themeJson.tokenColors || []),
              ];
              themeJson.colors = { ...includeJson.colors, ...themeJson.colors };
            } catch {
              // Failed to resolve include, continue with what we have
            }
          }

          return themeJson;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

async function getHighlighter(): Promise<{ highlighter: Highlighter; themeName: string }> {
  const currentThemeSetting = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") || "";

  // Re-use if theme hasn't changed
  if (highlighterInstance && loadedThemeSetting === currentThemeSetting && loadedShikiThemeName) {
    return { highlighter: highlighterInstance, themeName: loadedShikiThemeName };
  }

  // Coalesce concurrent (re)initialization to avoid disposing an instance another caller is about to use
  if (highlighterPromise) return highlighterPromise;

  highlighterPromise = (async () => {
    // Dispose old instance
    if (highlighterInstance) {
      highlighterInstance.dispose();
      highlighterInstance = null;
    }

    // Try to load the user's actual theme
    const userTheme = await loadUserTheme();

    if (userTheme) {
      try {
        const themeName = (userTheme as { name?: string }).name || currentThemeSetting || "user-theme";
        // Ensure the loaded theme object exposes the name we'll query shiki with
        (userTheme as { name: string }).name = themeName;
        highlighterInstance = await createHighlighter({
          themes: [userTheme as never],
          langs: SUPPORTED_LANGUAGES,
        });
        loadedThemeSetting = currentThemeSetting;
        loadedShikiThemeName = themeName;
        return { highlighter: highlighterInstance, themeName };
      } catch {
        // Fall through to bundled themes
      }
    }

    // Fallback to bundled dark-plus / light-plus
    const kind = vscode.window.activeColorTheme.kind;
    const fallbackTheme = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
      ? "dark-plus"
      : "light-plus";

    highlighterInstance = await createHighlighter({
      themes: [fallbackTheme],
      langs: SUPPORTED_LANGUAGES,
    });
    loadedThemeSetting = currentThemeSetting;
    loadedShikiThemeName = fallbackTheme;
    return { highlighter: highlighterInstance, themeName: fallbackTheme };
  })();

  try {
    return await highlighterPromise;
  } finally {
    highlighterPromise = null;
  }
}

export async function highlightCode(code: string, language: string): Promise<HighlightedLine[]> {
  try {
    const { highlighter, themeName } = await getHighlighter();

    const lang = SUPPORTED_LANGUAGES.includes(language as BundledLanguage)
      ? (language as BundledLanguage)
      : "text" as BundledLanguage;

    const tokens = highlighter.codeToTokens(code, { lang, theme: themeName });

    return tokens.tokens.map((lineTokens) =>
      lineTokens.map((token) => ({
        content: token.content,
        ...(token.color ? { color: token.color } : {}),
      })),
    );
  } catch {
    // Fallback: return plain text tokens (one token per line)
    return code.split("\n").map((line) => [{ content: line }]);
  }
}

export function invalidateHighlighter(): void {
  loadedThemeSetting = null;
  loadedShikiThemeName = null;
  if (highlighterInstance) {
    highlighterInstance.dispose();
    highlighterInstance = null;
  }
}

export function disposeHighlighter(): void {
  loadedThemeSetting = null;
  loadedShikiThemeName = null;
  if (highlighterInstance) {
    highlighterInstance.dispose();
    highlighterInstance = null;
  }
}
