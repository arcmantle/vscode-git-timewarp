import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";

let highlighterInstance: Highlighter | null = null;
let loadedThemeName: string | null = null;

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
  if (highlighterInstance && loadedThemeName === currentThemeSetting) {
    return { highlighter: highlighterInstance, themeName: loadedThemeName };
  }

  // Dispose old instance
  if (highlighterInstance) {
    highlighterInstance.dispose();
    highlighterInstance = null;
  }

  // Try to load the user's actual theme
  const userTheme = await loadUserTheme();

  if (userTheme) {
    try {
      highlighterInstance = await createHighlighter({
        themes: [userTheme as never],
        langs: SUPPORTED_LANGUAGES,
      });
      loadedThemeName = currentThemeSetting;
      return { highlighter: highlighterInstance, themeName: (userTheme as { name: string }).name };
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
  loadedThemeName = currentThemeSetting;
  return { highlighter: highlighterInstance, themeName: fallbackTheme };
}

export async function highlightCode(code: string, language: string): Promise<string[]> {
  try {
    const { highlighter, themeName } = await getHighlighter();

    const lang = SUPPORTED_LANGUAGES.includes(language as BundledLanguage)
      ? (language as BundledLanguage)
      : "text" as BundledLanguage;

    const tokens = highlighter.codeToTokens(code, { lang, theme: themeName });

    // Convert tokens to HTML spans per line
    return tokens.tokens.map((lineTokens) => {
      return lineTokens
        .map((token) => {
          const escaped = escapeHtml(token.content);
          if (token.color) {
            return `<span style="color:${token.color}">${escaped}</span>`;
          }
          return escaped;
        })
        .join("");
    });
  } catch {
    // Fallback: return escaped plain text lines
    return code.split("\n").map(escapeHtml);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function invalidateHighlighter(): void {
  loadedThemeName = null;
  if (highlighterInstance) {
    highlighterInstance.dispose();
    highlighterInstance = null;
  }
}

export function disposeHighlighter(): void {
  if (highlighterInstance) {
    highlighterInstance.dispose();
    highlighterInstance = null;
  }
}
