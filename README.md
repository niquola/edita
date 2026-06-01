# edita

> A local viewer for **AI coding agents** — see and review the files an agent is working on, right in your browser.

When an AI agent (Claude Code, Cursor, etc.) edits your codebase, edita gives you a window onto exactly those files: open any file or folder by its **real filesystem path**, rendered like a GitHub repo — markdown, syntax-highlighted code, git history, inline diffs. Then start a **review session**, click any line in any file, and leave notes. The notes are written to plain Markdown that the agent reads back to act on your feedback — closing the human-in-the-loop review without leaving the terminal.

It's designed to run as an **agent skill**: the agent (or you) starts one long-running daemon, and everything is reachable at `http://localhost:3456/<absolute/path>`. Because every page is served at its real path, relative links between files just work.

*(The name is "edit" in Spanish — inline editing is on the roadmap.)*

## Use with an AI agent

1. The agent starts the daemon once (`edita daemon`) and shares links to the files it touches.
2. You browse them in the viewer — rendered markdown, highlighted code, git history/diffs.
3. You hit the review toggle, click lines, and leave notes across as many files as you like.
4. Notes land in `~/.edita/review-<timestamp>.md` — an agent-readable file the agent reads to apply your feedback.

## Features

**Viewing**
- **Path-as-URL** — the URL path *is* the filesystem path, so `[link](./other.md)`, `../up.md` and `/abs/paths` resolve natively and open in the viewer.
- **Markdown** — GFM tables / task-lists / autolinks, KaTeX math (`$$…$$` and `$…$`), server-side Mermaid diagrams, heading anchors, YAML frontmatter rendered as a metadata card.
- **Code** — any non-markdown text file is Shiki-highlighted (30+ languages, dual light/dark theme) with a line-number gutter.
- **View tabs** — switch a file between **Preview / Source / Raw** (markdown) or **Code / Raw** (code).
- **Table of contents** — auto-generated from `h2`/`h3`, sticky in a right-hand column.
- **Live-reload** — per-file SSE; edit on disk and the tab refreshes (and if the file is deleted, the tab jumps to its folder).
- **Dark mode** — follows `prefers-color-scheme`.

**Git**
- **GitHub-style directory listing** — octicon icons, dotfiles, and for git repos each entry shows its **last commit (who / when)**; git-ignored entries are dimmed.
- **Breadcrumb** — clickable filesystem path on every page; git-root folders are marked with a git-branch icon.
- **History tab** — files and folders tracked in git get a commit timeline grouped by date; each commit is an accordion that expands its **diff inline** (via [htmx](https://htmx.org), no page reload).

**Review mode** (powered by [Datastar](https://data-star.dev))
- A review-toggle icon sits in the top-right corner. Start a review and the whole viewer enters review mode with a right sidebar.
- Click a line number (shift-click to extend a range) to attach a note; write your comment and add it.
- Move between files freely — notes accumulate into **one session**, grouped by file, each deletable.
- Notes are saved to `~/.edita/review-<timestamp>.md` in an agent-readable format. Finishing the review opens that file.

**Editing**
- A trash icon on the tab line deletes the current file (with confirmation), then redirects to its folder.

Binary/media files (images, PDFs, fonts, archives) are served raw.

## Requirements

[Bun](https://bun.sh) ≥ 1.2 (runs TypeScript directly — no build step).

## Install

```bash
git clone https://github.com/niquola/edita.git
cd edita
bun install
bun link            # optional: puts `edita` on your PATH
```

## Usage

### Daemon (recommended)

```bash
bun src/cli.ts daemon          # default port 3456
bun src/cli.ts daemon status   # show pid + URL
bun src/cli.ts daemon stop
```

Then open anything by its absolute path:

```
http://localhost:3456/Users/me/project/README.md     # markdown → rendered
http://localhost:3456/Users/me/project/src/app.ts     # code → highlighted
http://localhost:3456/Users/me/project                # directory → listing
```

Handy shell helper:

```bash
open "http://localhost:3456$(realpath README.md)"
```

### Other commands

```bash
bun src/cli.ts render README.md            # → standalone README.html
bun src/cli.ts serve ./docs 4000           # dev server scoped to a path
```

| Command | Description |
|---------|-------------|
| `daemon [port]` | Long-running viewer; open any file/folder at its real path (default port: `3456`). |
| `daemon status` / `daemon stop` | Inspect / shut down the running daemon. |
| `render <file.md> [output.html]` | Render a markdown file to standalone HTML. |
| `serve <file-or-dir> [port]` | Dev server scoped to a path, with live-reload. |

## Review file format

A review session is a single Markdown file an agent (or you) can read directly:

```markdown
# Review — 2026-06-01T14:11:04Z

## /Users/me/project/src/app.ts L42-45
extract this into a helper

## /Users/me/project/README.md L10
broken link here
```

## How it works

```
Markdown → frontmatter strip → Mermaid → KaTeX
        → remark-parse → remark-gfm → remark-rehype → rehype-raw
        → headings (TOC + anchors) → external links → Shiki → HTML
```

Non-markdown text files skip the pipeline and render as a Shiki code view. The daemon maps each request's URL path directly to a filesystem path: a directory yields a listing, a text file is rendered, everything else is streamed raw. Git history/diffs come from `git log`/`git show`; review state lives in `~/.edita/`. Interactivity uses htmx (history diffs) and Datastar (review mode); both stream Server-Sent Events.

Built on [unified](https://unifiedjs.com/) / remark / rehype, [Shiki](https://shiki.style), [KaTeX](https://katex.org), [beautiful-mermaid](https://www.npmjs.com/package/beautiful-mermaid), [htmx](https://htmx.org) and [Datastar](https://data-star.dev). YAML frontmatter is parsed with Bun's native `Bun.YAML`.

## License

MIT © niquola
