# edita

> Open any file or folder in the browser by its real filesystem path — a local, GitHub-style viewer.

Run one daemon, then point your browser at `http://localhost:3456/<absolute/path>`. Markdown renders beautifully, source code gets syntax highlighting, directories list with a clickable breadcrumb. Because every page is served at its **real path**, relative links between files just work.

*(Editing is on the roadmap — hence the name `edita`, "edit" in Spanish.)*

## Features

- **Path-as-URL** — the URL path *is* the filesystem path, so `[link](./other.md)`, `../up.md` and `/abs/paths` resolve natively and open in the viewer.
- **Markdown** — GFM tables / task-lists / autolinks, KaTeX math (`$$…$$` and `$…$`), server-side Mermaid diagrams, heading anchors.
- **Frontmatter** — leading YAML (`---…---`) is parsed and shown as a tidy metadata card; `title`/`name` set the page title.
- **Code view** — any non-markdown text file is Shiki-highlighted (30+ languages, dual light/dark theme) with line numbers.
- **View tabs** — switch a file between **Preview / Source / Raw** (markdown) or **Code / Raw** (code); folders get **Files / History**.
- **Git history** — files and folders tracked in git get a **History** tab: a GitHub-style commit timeline grouped by date, each commit an accordion that expands its diff inline (via htmx, no page reload).
- **Directory browser** — GitHub-style file list with octicon icons; for git repos each entry shows its **last commit (who / when)**, and git-ignored entries are dimmed.
- **Breadcrumb** — clickable filesystem path atop every page; git-root folders are marked with a git-branch icon.
- **Table of contents** — auto-generated from `h2`/`h3`, sticky in a right-hand column.
- **Live-reload** — per-file SSE; edit on disk and the browser tab refreshes itself.
- **Dark mode** — follows `prefers-color-scheme`.

Binary/media files (images, PDFs, fonts, archives) are served raw.

## Requirements

[Bun](https://bun.sh) ≥ 1.2 (runs TypeScript directly — no build step).

## Install

```bash
git clone https://github.com/niquola/edita.git
cd edita
bun install
```

Optionally link it as a global command:

```bash
bun link            # then `edita` is available on your PATH
```

## Usage

### Daemon (recommended)

A long-running viewer. Start it once:

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

### Render to a standalone HTML file

```bash
bun src/cli.ts render README.md             # → README.html
bun src/cli.ts render doc.md /tmp/doc.html
```

### Dev server scoped to a path

```bash
bun src/cli.ts serve .            # serve a directory at http://localhost:3456
bun src/cli.ts serve paper.md 8080
```

## Commands

| Command | Description |
|---------|-------------|
| `daemon [port]` | Long-running viewer; open any file/folder at its real path (default port: `3456`). |
| `daemon status` / `daemon stop` | Inspect / shut down the running daemon. |
| `render <file.md> [output.html]` | Render a markdown file to standalone HTML. |
| `serve <file-or-dir> [port]` | Dev server scoped to a path, with live-reload. |

## How it works

```
Markdown → frontmatter strip → Mermaid preprocessing → KaTeX preprocessing
        → remark-parse → remark-gfm → remark-rehype → rehype-raw
        → rehype-heading-ids (TOC + anchors)
        → rehype-link-transform (external links → _blank)
        → rehype-shiki (syntax highlighting)
        → rehype-stringify → HTML
```

Non-markdown text files skip the pipeline and go straight to a Shiki code view. The daemon maps each request's URL path directly to a filesystem path, serves a directory listing for folders, renders markdown/code for text files, and streams everything else raw.

Built on [unified](https://unifiedjs.com/) / remark / rehype, [Shiki](https://shiki.style), [KaTeX](https://katex.org), and [beautiful-mermaid](https://www.npmjs.com/package/beautiful-mermaid). YAML frontmatter is parsed with Bun's native `Bun.YAML`.

## License

MIT © niquola
