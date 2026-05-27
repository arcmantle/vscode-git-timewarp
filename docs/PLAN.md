# Implementation Plan: Git Timewarp

## Overview

A VS Code extension that adds a temporal Z-axis to the editor. `Ctrl+Scroll` navigates backward/forward through a file's git history and VS Code local history, preserving scroll position with smooth transitions. TypeScript, ESM, esbuild.

## Architecture Decisions

- **TextDocumentContentProvider** for serving historical file content via a custom `timewarp:` URI scheme — this is the standard VS Code pattern for showing read-only virtual documents.
- **Git CLI spawning** (not libgit2/WASM) for history retrieval — simpler, proven fast enough with caching, and `git` is always available in environments where this extension is useful.
- **In-memory LRU cache** for file contents at specific commits — avoids re-spawning git on every scroll tick.
- **Unified timeline model** — git commits and VS Code local history entries are normalized into a single ordered list per file.
- **Keybinding-based navigation** (not raw scroll interception) — VS Code doesn't expose mouse scroll events to extensions. We use `Ctrl+[` / `Ctrl+]` as primary, and register a `editorScroll`-triggered command if feasible via `when` clause bindings.
- **Editor replacement strategy** — open the historical version in the same editor group/tab position using `vscode.open` with `ViewColumn` preservation, rather than side-by-side.

## Task List

### Phase 1: Project Scaffolding & Spike

#### Task 1: Initialize Extension Project

**Description:** Set up the VS Code extension project with TypeScript, ESM, esbuild bundling, and all necessary configuration files.

**Acceptance criteria:**
- [ ] `package.json` with extension manifest (name, publisher, engines, activationEvents)
- [ ] `tsconfig.json` targeting ESNext with ESM module resolution
- [ ] `esbuild.config.mjs` producing a single bundled `.js` for the extension
- [ ] `src/extension.ts` with empty `activate`/`deactivate` exports
- [ ] Extension compiles and loads in VS Code Extension Development Host
- [ ] `.vscodeignore` and basic `.gitignore` present

**Verification:**
- [ ] `pnpm run build` succeeds
- [ ] F5 launches Extension Development Host without errors
- [ ] "Git Timewarp" appears in Extensions list (dev mode)

**Dependencies:** None

**Files likely touched:**
- `package.json`
- `tsconfig.json`
- `esbuild.config.mjs`
- `src/extension.ts`
- `.vscodeignore`
- `.gitignore`

**Estimated scope:** Small

---

#### Task 2: Spike — Keybinding Capture & Ctrl+Scroll Feasibility

**Description:** Validate that we can capture `Ctrl+[` / `Ctrl+]` keybindings and explore whether `Ctrl+Scroll` can be mapped. Document findings. This is a time-boxed spike (1 hour) — the output is knowledge, not production code.

**Acceptance criteria:**
- [ ] Keybindings `Ctrl+[` and `Ctrl+]` registered and trigger custom commands
- [ ] Document whether `Ctrl+Scroll` (mousewheel) can be captured (likely answer: not directly — document the workaround or alternative)
- [ ] Commands log to output channel when triggered, proving the binding works

**Verification:**
- [ ] Press `Ctrl+]` in an editor → see log message in Output panel
- [ ] Press `Ctrl+[` in an editor → see log message in Output panel
- [ ] Findings documented in code comments or a short spike note

**Dependencies:** Task 1

**Files likely touched:**
- `package.json` (contributes.keybindings, contributes.commands)
- `src/extension.ts`

**Estimated scope:** Small

---

### Checkpoint: After Phase 1
- [ ] Extension loads and keybindings fire
- [ ] We know the input model that will work (keyboard vs scroll)
- [ ] Build pipeline works end-to-end

---

### Phase 2: Git History Backend

#### Task 3: Git History Provider

**Description:** Implement a module that retrieves the list of commits touching a specific file, returning structured commit metadata (hash, author, date, message).

**Acceptance criteria:**
- [ ] `GitHistoryProvider` class/module with method `getFileHistory(filePath): Promise<Commit[]>`
- [ ] Uses `git log --follow --format=...` to get commit list for a file
- [ ] Handles files not in a git repo gracefully (returns empty)
- [ ] Returns commits in reverse chronological order (newest first)
- [ ] Includes hash, author name, date (ISO), and subject line

**Verification:**
- [ ] Unit test: mock `git log` output, verify parsing
- [ ] Integration test: run against a real repo, verify non-empty result
- [ ] Handles non-git directory without throwing

**Dependencies:** Task 1

**Files likely touched:**
- `src/git/history-provider.ts`
- `src/git/types.ts`
- `tests/git/history-provider.test.ts`

**Estimated scope:** Small

---

#### Task 4: Git File Content Retrieval with Caching

**Description:** Implement retrieval of file content at a specific commit, with an LRU cache to avoid repeated git calls during rapid navigation.

**Acceptance criteria:**
- [ ] `getFileAtCommit(filePath, commitHash): Promise<string>` using `git show <hash>:<path>`
- [ ] LRU cache (configurable size, default 50 entries) keyed by `${hash}:${path}`
- [ ] Cache hit returns immediately without spawning a process
- [ ] Handles binary files gracefully (returns null or throws descriptive error)
- [ ] Handles missing files at a commit (file didn't exist yet) gracefully

**Verification:**
- [ ] Unit test: verify cache hit avoids subprocess
- [ ] Unit test: verify correct content returned for known commit
- [ ] Test: requesting a file that doesn't exist at that commit returns null

**Dependencies:** Task 3

**Files likely touched:**
- `src/git/content-provider.ts`
- `src/cache/lru-cache.ts`
- `tests/git/content-provider.test.ts`

**Estimated scope:** Small

---

### Checkpoint: After Phase 2
- [ ] Can programmatically retrieve full file history and content at any commit
- [ ] Cache works and is tested
- [ ] All tests pass

---

### Phase 3: VS Code Local History Integration

#### Task 5: Local History Provider

**Description:** Integrate with VS Code's local history to retrieve timeline entries for a file, filling the gap between git commits.

**Acceptance criteria:**
- [ ] Uses VS Code's `timeline` API (`vscode.extensions.getExtension` or `workspace.timeline`) to fetch local history entries
- [ ] Returns entries in the same normalized format as git commits (timestamp, label, content URI)
- [ ] Falls back gracefully if local history is unavailable or empty

**Verification:**
- [ ] With a file that has local history: entries are returned
- [ ] With a file that has no local history: empty array returned, no error
- [ ] Entries have timestamps and are ordered chronologically

**Dependencies:** Task 1

**Files likely touched:**
- `src/history/local-history-provider.ts`
- `src/history/types.ts`
- `tests/history/local-history-provider.test.ts`

**Estimated scope:** Small

---

#### Task 6: Unified Timeline Model

**Description:** Merge git commits and local history entries into a single chronologically-ordered timeline for a file. This is the data structure navigation commands will operate on.

**Acceptance criteria:**
- [ ] `Timeline` class that merges git commits and local history entries by timestamp
- [ ] Exposes `current()`, `previous()`, `next()`, `jumpToPresent()` navigation methods
- [ ] Tracks current position in the timeline (cursor)
- [ ] HEAD/present is always position 0; going "back" increases the index
- [ ] Deduplicates entries where a local history entry and a git commit are the same moment

**Verification:**
- [ ] Unit test: interleaving of git and local history entries by date
- [ ] Unit test: navigation forward/back/jump-to-present
- [ ] Unit test: deduplication logic

**Dependencies:** Tasks 3, 5

**Files likely touched:**
- `src/history/timeline.ts`
- `src/history/types.ts`
- `tests/history/timeline.test.ts`

**Estimated scope:** Medium

---

### Checkpoint: After Phase 3
- [ ] Unified timeline merges both sources correctly
- [ ] Navigation state (cursor) works
- [ ] All tests pass

---

### Phase 4: Editor Integration — Core UX

#### Task 7: TextDocumentContentProvider for Historical Content

**Description:** Register a `TextDocumentContentProvider` for the `timewarp:` URI scheme that serves file content at a specific point in the timeline.

**Acceptance criteria:**
- [ ] `timewarp:` scheme registered
- [ ] URI encodes: original file path + timeline entry identifier (commit hash or local history ID)
- [ ] Provider resolves URI → file content string
- [ ] Content is served as read-only (VS Code handles this automatically for virtual documents)
- [ ] Language mode matches the original file (derived from file extension in URI)

**Verification:**
- [ ] Opening a `timewarp:` URI shows correct historical content
- [ ] Document is read-only (cannot type into it)
- [ ] Syntax highlighting works (language mode set correctly)

**Dependencies:** Tasks 4, 6

**Files likely touched:**
- `src/editor/content-provider.ts`
- `src/editor/uri-utils.ts`
- `tests/editor/content-provider.test.ts`

**Estimated scope:** Small

---

#### Task 8: Navigation Commands (Back / Forward / Return to Present)

**Description:** Implement the three core commands that drive the time-travel UX: step back, step forward, and return to present.

**Acceptance criteria:**
- [ ] `gitTimewarp.back` command: moves one step back in the timeline, opens historical version in the same editor position
- [ ] `gitTimewarp.forward` command: moves one step forward toward present
- [ ] `gitTimewarp.returnToPresent` command: jumps back to HEAD / current file
- [ ] Commands are no-ops when at boundaries (can't go back past file creation, can't go forward past present)
- [ ] Status bar or editor title updates to show timeline position

**Verification:**
- [ ] Pressing `Ctrl+]` (back) shows previous version
- [ ] Pressing `Ctrl+[` (forward) returns toward present
- [ ] Pressing `Escape` returns to live file from any point in history
- [ ] At the oldest commit, "back" does nothing (or shows subtle notification)

**Dependencies:** Tasks 6, 7

**Files likely touched:**
- `src/commands/navigate.ts`
- `src/extension.ts` (command registration)
- `package.json` (commands + keybindings)

**Estimated scope:** Medium

---

#### Task 9: Scroll Position Preservation

**Description:** When navigating between timeline entries, preserve the user's viewport position by anchoring to the cursor line (or viewport center if no cursor context).

**Acceptance criteria:**
- [ ] Record cursor line number and viewport range before switching versions
- [ ] After switching, set cursor to the same line number (clamped to file length)
- [ ] Scroll the viewport so that line is at the same relative position (top/center/bottom of view)
- [ ] If the file is shorter than the anchored line, scroll to the end

**Verification:**
- [ ] Navigate back on a file while at line 50 → historical version is also scrolled to line 50
- [ ] If historical version has only 30 lines and anchor was line 50, cursor is at line 30
- [ ] Viewport position feels stable (no jarring jumps)

**Dependencies:** Task 8

**Files likely touched:**
- `src/editor/scroll-anchor.ts`
- `src/commands/navigate.ts` (integrate anchoring)
- `tests/editor/scroll-anchor.test.ts`

**Estimated scope:** Small

---

### Checkpoint: After Phase 4
- [ ] Full navigation loop works: back → see old version → forward → return to present
- [ ] Scroll position preserved
- [ ] Read-only enforced on historical views
- [ ] Keybindings work

---

### Phase 5: Visual Polish & Status

#### Task 10: Time Indicator UI

**Description:** Show a subtle, non-intrusive indicator of where the user is in time. This could be a status bar item, editor title decoration, or both.

**Acceptance criteria:**
- [ ] When viewing a historical version: status bar shows "⏪ 3 commits ago · @alice · 2 days ago"
- [ ] When at present: status bar item is hidden or shows nothing
- [ ] Clicking the status bar item could show the full commit message (stretch)
- [ ] Editor tab title includes a time indicator (e.g., `file.ts (3 ago)`)

**Verification:**
- [ ] Navigate back → status bar updates with correct info
- [ ] Navigate to present → indicator disappears
- [ ] Info is accurate (correct author, correct relative time)

**Dependencies:** Task 8

**Files likely touched:**
- `src/ui/status-bar.ts`
- `src/ui/tab-title.ts`
- `src/extension.ts` (register status bar)

**Estimated scope:** Small

---

#### Task 11: Fade Transition Effect

**Description:** Implement a subtle visual transition (~200ms) when switching between timeline entries to prevent jarring content replacement.

**Acceptance criteria:**
- [ ] When navigating, editor content transitions smoothly (not an instant swap)
- [ ] Transition duration is configurable via setting (default 200ms)
- [ ] If user navigates rapidly (multiple steps within transition time), intermediate states are skipped (debounce)
- [ ] Transition works via editor decoration opacity or similar VS Code-supported mechanism

**Verification:**
- [ ] Navigating back produces a perceptible-but-quick transition
- [ ] Rapidly pressing `Ctrl+]` 5 times doesn't produce 5 sequential transitions — it settles on the final state
- [ ] Setting transition to 0ms disables the effect

**Dependencies:** Task 8

**Files likely touched:**
- `src/ui/transition.ts`
- `src/commands/navigate.ts` (integrate transition/debounce)
- `package.json` (configuration settings)

**Estimated scope:** Medium (VS Code API may limit what's possible here — may need creative decoration-based approach)

---

### Checkpoint: After Phase 5
- [ ] Full UX loop feels polished
- [ ] Status bar communicates position in time
- [ ] Transitions prevent disorientation
- [ ] Rapid navigation is debounced

---

### Phase 6: Configuration & Edge Cases

#### Task 12: Extension Configuration

**Description:** Add user-configurable settings for the extension behavior.

**Acceptance criteria:**
- [ ] `gitTimewarp.transitionDuration` — number in ms (default 200)
- [ ] `gitTimewarp.cacheSize` — number of cached file versions (default 50)
- [ ] `gitTimewarp.followRenames` — whether to use `--follow` in git log (default true)
- [ ] `gitTimewarp.includeLocalHistory` — whether to include VS Code local history (default true)
- [ ] Settings are read at activation and respected by relevant modules

**Verification:**
- [ ] Changing `transitionDuration` to 0 disables transitions
- [ ] Changing `cacheSize` to 5 evicts old entries
- [ ] Disabling `includeLocalHistory` shows only git commits

**Dependencies:** Tasks 4, 6, 11

**Files likely touched:**
- `package.json` (contributes.configuration)
- `src/config.ts`
- Consumers of config: cache, timeline, transition modules

**Estimated scope:** Small

---

#### Task 13: Edge Case Handling

**Description:** Handle edge cases: non-git files, new unsaved files, binary files, very large histories, renamed files.

**Acceptance criteria:**
- [ ] File not in git: commands are disabled (greyed out), no errors
- [ ] New unsaved file: commands disabled
- [ ] Binary file: commands disabled with informative message
- [ ] File with 1000+ commits: timeline loads lazily (first 100, then more on demand)
- [ ] Renamed file: history follows renames when `followRenames` is enabled
- [ ] Reaching end of history: subtle notification "Beginning of file history"

**Verification:**
- [ ] Open a non-git file → commands don't appear in command palette (or show as disabled)
- [ ] Open a binary → no crash, informative message
- [ ] File with long history → doesn't hang on initial load

**Dependencies:** Tasks 3, 6, 8

**Files likely touched:**
- `src/commands/navigate.ts` (guards)
- `src/git/history-provider.ts` (pagination, rename following)
- `src/history/timeline.ts` (lazy loading)

**Estimated scope:** Medium

---

### Checkpoint: After Phase 6
- [ ] Extension is configurable
- [ ] No crashes on edge cases
- [ ] Graceful degradation for non-git files

---

### Phase 7: Packaging & Ship

#### Task 14: Extension Packaging & Metadata

**Description:** Prepare the extension for distribution: README, icon, marketplace metadata, VSIX packaging.

**Acceptance criteria:**
- [ ] `README.md` with description, demo GIF placeholder, feature list, keybindings table
- [ ] Extension icon (simple, recognizable)
- [ ] `CHANGELOG.md` with v0.1.0 entry
- [ ] `vsce package` produces a valid `.vsix` file
- [ ] Extension activates only when needed (`onCommand:` activation events)

**Verification:**
- [ ] `pnpm run package` produces `.vsix`
- [ ] Installing the `.vsix` in VS Code works
- [ ] Extension doesn't activate until a timewarp command is invoked (no startup cost)

**Dependencies:** All previous tasks

**Files likely touched:**
- `README.md`
- `CHANGELOG.md`
- `package.json` (metadata, activation events)
- `.vscodeignore` (final tuning)
- `assets/icon.png`

**Estimated scope:** Small

---

### Final Checkpoint
- [ ] All tests pass
- [ ] Extension builds and packages cleanly
- [ ] Full navigation loop works: `Ctrl+]` back → see history → `Ctrl+[` forward → `Escape` to present
- [ ] Scroll position preserved throughout
- [ ] Status bar shows position in time
- [ ] Works on macOS, Windows, Linux (keybindings may differ)
- [ ] No performance issues on files with 100+ commits
- [ ] Edge cases handled gracefully

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ctrl+Scroll not capturable by VS Code | High | Keybindings (`Ctrl+[`/`Ctrl+]`) are the primary input. Scroll is a nice-to-have, not a requirement. |
| Fade transitions not possible via VS Code API | Medium | Degrade gracefully to instant swap. The core value (navigate time) doesn't depend on animation. |
| `git show` too slow for large repos | Medium | LRU cache + pre-fetch adjacent commits. Lazy-load timeline. |
| Scroll position mapping breaks on heavily refactored files | Low | Simple line-number anchoring is good enough for v1. Semantic anchoring is a v2 problem. |
| VS Code local history API is internal/unstable | Medium | Make local history optional and feature-flagged. Git alone is sufficient for MVP. |
| `Ctrl+[` / `Ctrl+]` conflicts with existing VS Code keybindings | High | `Ctrl+[` is "outdent" by default. Need different defaults — consider `Alt+[` / `Alt+]` or `Ctrl+Alt+[` / `Ctrl+Alt+]`. |

## Open Questions

- What keybinding defaults avoid conflicts? `Ctrl+[`/`Ctrl+]` conflicts with indent/outdent. `Alt+,`/`Alt+.` (like browser back/forward) might be more natural.
- Should we pre-fetch N adjacent commits on first navigation for instant subsequent steps?
- What's the maximum practical timeline size before we need virtual scrolling / date-based jump?
- Should the extension integrate with VS Code's built-in Timeline view for discoverability?
