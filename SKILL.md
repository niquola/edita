---
name: edita
description: Local file viewer + code-review daemon for showing the user files this agent is working on. `edita open <file> [L42-45:comment @word C5-12]` opens any file/folder in the browser by its real path (GitHub-style — Markdown, syntax-highlighted code, directory listings, git history & inline diffs) and can highlight/underline/annotate exact lines, words or columns to point the user at precise spots. `edita review` drives a human-in-the-loop review whose line-notes are saved to ~/.edita/review-<ts>.md for the agent to read back. Use to preview/review markdown or code, browse a folder, show the user an exact location, or collect review of local files.
---

# edita — Local Viewer & Review for Agents

A local viewer for **showing the user the files this agent is working on**, and collecting their review. It gives an agent a *display*: a stable browser URL for any path on disk, rendered GitHub-style (markdown, highlighted code, directory listings, git history/diffs), where you can point at exact lines/words/columns — and a review mode whose notes come back as an agent-readable file.

> Install: `bun install`. Run commands as `bun src/cli.ts <cmd>` (or `bun link` once, then `edita <cmd>`). Requires [Bun](https://bun.sh) ≥ 1.2.

## The agent loop

```bash
# 1. Show the user a file, pointing at exact spots
edita open src/auth.ts 'L42-48:this path skips validation' 'L51@token'

# 2. Start a review session and let the user annotate across files
edita review start
edita open src/auth.ts           # opens in review mode (right sidebar; user clicks lines → notes)

# 3. Read the user's feedback back and apply it
edita review notes               # prints ~/.edita/review-<ts>.md (entries: "## <path> L<a>-<b>\n<comment>")
edita review stop                # finish (opens the review file in the browser)
```

`edita open` starts the daemon if it isn't running. Every page is served at its **real filesystem path** (`http://localhost:3456/<abs/path>`), so relative links between files just work.

## Pointing at exact spots (deep-link anchors)

Anchors after the path (in a URL: the `#` hash, `;`-separated) — `L<a>[-<b>][C<c1>-<c2>][@word][:comment]`:

```bash
edita open f.ts L42                        # highlight line 42
edita open f.ts L42-45                      # highlight a range
edita open f.ts 'L42@fetchUser'             # underline the word "fetchUser"
edita open f.ts 'L42C5-12'                  # underline exact columns 5–12
edita open f.ts 'L42-45:extract this'       # highlight + a yellow note above the lines
edita open f.ts 'L10:a' 'L80@auth:b'        # several spots at once
```

The note renders as a bright-yellow callout (prefixed with its line range) above the lines; words/columns get an amber underline. **Prefer this over describing line numbers in prose** — it puts the user's eyes exactly where you mean.

## Commands

| Command | Description |
|---------|-------------|
| `open <file-or-dir> [anchors…]` | Open in the browser (starts the daemon if needed); anchors highlight / underline / annotate. |
| `review start` | Start a system-wide review session (`~/.edita/review-<ts>.md`, marked active). |
| `review open` | Open the active review file in the browser. |
| `review notes` | Print the active review (for the agent to read & apply). |
| `review status` / `review path` / `review stop` | Inspect / locate / finish the review. |
| `daemon [port]` | Long-running viewer (default port `3456`). `daemon status` / `daemon stop`. |
| `render <file.md> [out.html]` | Render a markdown file to standalone HTML. |
| `serve <file-or-dir> [port]` | Dev server scoped to a path, with live-reload. |

## Review file format (agent-readable)

```markdown
# Review — 2026-06-01T17:12:56Z

## /Users/me/project/src/auth.ts L42-48
this path skips validation

## /Users/me/project/README.md L10
broken link
```

The user can also drive the review entirely in the browser: a review-toggle icon (top-right) starts/finishes; clicking line numbers (shift-click to extend) attaches a note in the right sidebar; notes group by file and are deletable.

## What it renders

- **Markdown** — GFM, KaTeX math, server-side Mermaid, YAML frontmatter as a metadata card, sticky TOC.
- **Code** — Shiki highlighting (30+ langs, dual light/dark), line-number gutter, full-width.
- **Directories** — GitHub-style listing with octicon icons, dotfiles, per-entry last commit (who/when), dimmed git-ignored entries.
- **Git** — a History tab with a date-grouped commit timeline; each commit expands its diff inline.
- **Tabs** — Preview / Source / Raw (markdown) · Code / Raw (code) · Files / History (folders); a trash icon deletes a file.
- Live-reload per file; dark mode via `prefers-color-scheme`.
