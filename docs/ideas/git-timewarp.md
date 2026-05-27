# Git Timewarp

## Problem Statement

How might we give developers an intuitive, in-place way to navigate a file's history — treating time as a navigable dimension in the editor rather than a separate tool to context-switch into?

## Recommended Direction

**Z-Axis Scroll: Whole-file time travel with scroll position preservation.**

The core interaction: `Ctrl+Scroll` (mousewheel) moves the active editor backward and forward through a file's history. The content transitions with a quick ~200ms fade. Scroll position is anchored to the line at cursor or viewport center, so you never lose your place. A subtle overlay indicates where you are in time ("3 commits ago — @alice, 2 days ago").

History sources include both git commits and VS Code's local history API, unified into a single timeline. Local history fills the gaps between commits, giving sub-commit granularity that's especially useful for understanding recent exploratory changes.

Keyboard fallback: `Ctrl+[` / `Ctrl+]` for accessibility and precision. `Escape` or scrolling to the present returns you to HEAD.

The long-term vision (v2+) evolves this into per-function/block scoping — only the code region under your cursor time-travels while surrounding code stays at HEAD. But that requires solving function-mapping-across-commits, which is a hard problem best tackled after the core is proven.

## Key Assumptions to Validate

- [ ] VS Code extension API supports intercepting Ctrl+Scroll or can simulate it via keybindings with `editorScroll` — test with a minimal extension that captures the event
- [ ] `git show <commit>:<file>` is fast enough (<50ms) for fluid scrolling feel — benchmark on repos with 1000+ commits on a single file
- [ ] Line-anchored scroll preservation works intuitively — prototype with a simple "jump between two versions" and observe if users feel oriented
- [ ] VS Code's `timeline` API or local history file access provides sufficient data for sub-commit history — spike a proof-of-concept reading local history entries
- [ ] The 200ms fade transition feels smooth without being sluggish — user-test with 100ms, 200ms, and 300ms variants

## MVP Scope

**In:**
- `Ctrl+Scroll` moves backward/forward through git commits that touched the active file
- VS Code local history entries interleaved in the timeline
- Scroll position preserved (anchored to cursor line)
- Subtle "time indicator" showing commit info (author, date, message, how many steps from HEAD)
- Quick fade transition (~200ms) between versions
- `Ctrl+[` / `Ctrl+]` keyboard alternative
- `Escape` to return to present
- Read-only state while viewing historical versions (prevent accidental edits)
- Works with any language/file type (no parsing required for v1)

**Tech stack:**
- TypeScript, ESM format
- esbuild for bundling
- VS Code Extension API (`TextDocumentContentProvider`, `Timeline` API, `workspace.fs`)
- Spawns `git` CLI for history retrieval (with result caching)

## Not Doing (and Why)

- **Per-function/block scoping** — Requires Tree-sitter or DocumentSymbol-based function detection AND cross-commit function mapping. Ship whole-file first, learn from it, then scope down.
- **Diff highlighting / inline changes** — Adds visual complexity. The point is to *see the past as it was*, not to see a diff. Diffs are already solved by other tools.
- **Multi-file time travel** — Navigating an entire repo state at a point in time is a different (much larger) product. Stay focused on single-file.
- **Write/edit in historical state** — Opens a can of worms (rewriting history? creating a branch?). Keep historical views strictly read-only.
- **Commit creation or git operations** — This is a *reading* tool, not a *writing* tool. No stage, commit, or branch actions.
- **Custom UI panels or webviews** — The power of this concept is that it lives IN the editor, not beside it. No sidebars, no panels.

## Open Questions

- Can `Ctrl+Scroll` be reliably captured across macOS/Windows/Linux, or will OS-level zoom intercept it? May need `Ctrl+Alt+Scroll` or a configurable binding.
- What happens when a file was renamed? Should we follow renames through `git log --follow`?
- How to handle very large histories (1000+ commits on a file)? Pagination? Jump-to-date?
- Should the time indicator show a minimap-style timeline in the scrollbar gutter?
- Performance: should we pre-cache adjacent commits on file open, or lazy-load on scroll?
- What's the right UX when you reach the beginning of history (file creation)? A subtle "end of history" indicator?
