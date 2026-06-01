/**
 * Markdown → HTML renderer
 *
 * Pipeline: remark-parse → remark-gfm → remark-rehype → rehype-raw → shiki → rehype-stringify
 * Features: GFM tables, Shiki syntax highlighting, KaTeX math, Mermaid diagrams, heading anchors + TOC
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import katex from "katex";
import { renderMermaid } from "beautiful-mermaid";
import path from "path";
import fs from "fs";
import type { Root } from "mdast";
import type { Element } from "hast";

/** Options that depend on WHERE the file lives — used for breadcrumb + link rewriting. */
export interface RenderOptions {
  /** Absolute path of the source file (enables breadcrumb + relative-link resolution). */
  filePath?: string;
  /** Rewrite local links + breadcrumb segments to the daemon's `/markdown?path=` endpoint. */
  daemon?: boolean;
  /** Current view tab — "preview" | "code" | "source" (drives the tab bar highlight). */
  view?: string;
}

// ── Shiki highlighter ──

const LANGUAGES: BundledLanguage[] = [
  "javascript", "typescript", "json", "yaml", "bash", "shell", "sql",
  "python", "java", "clojure", "http", "markdown", "html", "css", "xml",
  "go", "rust", "c", "cpp", "csharp", "ruby", "php", "dockerfile",
  "graphql", "diff", "toml", "zig", "elixir", "lua", "swift", "kotlin",
];

let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({ themes: ["github-light", "github-dark"], langs: LANGUAGES });
  }
  return highlighter;
}

function highlightCode(hl: Highlighter, code: string, lang?: string): string {
  const normalized = normalizeLanguage(lang);
  const loaded = hl.getLoadedLanguages();
  const langToUse = normalized && loaded.includes(normalized as BundledLanguage) ? normalized : "plaintext";
  try {
    return hl.codeToHtml(code, {
      lang: langToUse,
      themes: { light: "github-light", dark: "github-dark" },
    });
  } catch {
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
}

function normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const n = lang.toLowerCase().trim();
  const aliases: Record<string, string> = {
    js: "javascript", ts: "typescript", sh: "bash", zsh: "bash",
    yml: "yaml", py: "python", rb: "ruby", cs: "csharp",
    "c#": "csharp", "c++": "cpp", text: "plaintext", txt: "plaintext",
  };
  return aliases[n] || n;
}

// ── KaTeX ──

function processKaTeX(content: string): string {
  // Only process math in non-code segments. Fenced (```...```) and inline (`...`)
  // code is left untouched, so JS template literals like `${x}` aren't eaten.
  return splitByCode(content)
    .map((seg) => (seg.code ? seg.text : processMathSegment(seg.text)))
    .join("");
}

function processMathSegment(text: string): string {
  // Display math $$...$$
  let result = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, formula: string) => {
    try {
      return `<div class="katex-display">${katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false })}</div>`;
    } catch {
      return `<div class="katex-display katex-error">${escapeHtml(formula.trim())}</div>`;
    }
  });
  // Inline math $...$
  result = result.replace(/(?<!\$|\\)\$(?!\$)([^\n$]+?)(?<!\s)\$(?!\$)/g, (_m, formula: string) => {
    const t = formula.trim();
    if (!t || !/[\\^_{}+*=<>]/.test(t)) return _m;
    try {
      return `<span class="katex-inline">${katex.renderToString(t, { displayMode: false, throwOnError: false })}</span>`;
    } catch {
      return _m;
    }
  });
  return result;
}

/** Split content into code (fenced ```...``` or inline `...`) and non-code segments. */
function splitByCode(content: string): { text: string; code: boolean }[] {
  const segs: { text: string; code: boolean }[] = [];
  let rem = content;
  while (rem.length > 0) {
    const fenced = rem.match(/^([\s\S]*?)(```[\s\S]*?```)/);
    const inline = rem.match(/^([\s\S]*?)(`[^`\n]+`)/);
    let best: RegExpMatchArray | null = null;
    if (fenced && inline) best = (fenced[1] ?? "").length <= (inline[1] ?? "").length ? fenced : inline;
    else best = fenced ?? inline;
    if (best) {
      const before = best[1] ?? "";
      const code = best[2] ?? "";
      if (before.length) segs.push({ text: before, code: false });
      segs.push({ text: code, code: true });
      rem = rem.slice(before.length + code.length);
    } else {
      if (rem.length) segs.push({ text: rem, code: false });
      break;
    }
  }
  return segs;
}

// ── Mermaid ──

async function preprocessMermaid(content: string): Promise<string> {
  const regex = /```mermaid[^\n]*\n([\s\S]*?)```/g;
  const matches = [...content.matchAll(regex)];
  if (!matches.length) return content;

  let result = content;
  for (const match of matches.reverse()) {
    const code = match[1]!.trim();
    try {
      const svg = await renderMermaid(code, {
        bg: "#ffffff", fg: "#1D2331", line: "#717684", muted: "#717684",
        surface: "#F5F5F6", border: "#CCCED4", font: "system-ui, sans-serif", transparent: true,
      });
      result = result.slice(0, match.index!) + `<div class="mermaid-diagram">${svg}</div>` + result.slice(match.index! + match[0].length);
    } catch (e) {
      console.warn(`[mermaid] Render failed:`, e);
    }
  }
  return result;
}

// ── Rehype plugins ──

function rehypeShiki(hl: Highlighter) {
  return () => (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "pre") return;
      const codeNode = node.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
      if (!codeNode) return;

      const className = codeNode.properties?.className;
      const langClass = Array.isArray(className) ? className.find((c) => typeof c === "string" && c.startsWith("language-")) : undefined;
      const lang = langClass ? String(langClass).replace("language-", "") : undefined;
      const codeText = getTextContent(codeNode);

      if (lang === "mermaid") {
        (node as any).type = "raw";
        (node as any).value = `<div class="mermaid-diagram mermaid-fallback"><pre class="mermaid">${escapeHtml(codeText)}</pre></div>`;
        node.children = [];
        return;
      }

      const highlighted = highlightCode(hl, codeText, lang);
      (node as any).type = "raw";
      (node as any).value = highlighted;
      node.children = [];
    });
  };
}

export interface TocItem { id: string; text: string; level: number; }

function rehypeHeadingIds(toc: TocItem[]) {
  return () => (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (!["h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tagName)) return;
      const level = parseInt(node.tagName.charAt(1), 10);
      const text = getTextContent(node);
      const id = slugify(text);
      node.properties = node.properties || {};
      node.properties.id = id;
      // Inject anchor
      node.children.unshift({
        type: "element", tagName: "a",
        properties: { href: `#${id}`, className: ["heading-anchor"], ariaLabel: `Link to ${text}` },
        children: [],
      } as Element);
      if (level >= 2 && level <= 3) toc.push({ id, text, level });
    });
  };
}

function rehypeLinkTransform() {
  return () => (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a" || !node.properties?.href) return;
      const href = String(node.properties.href);
      // External links → open in a new tab. Local (relative/absolute) links are left
      // untouched: the daemon serves each page at its real filesystem path, so the
      // browser resolves `./other.md`, `../x.md`, `/abs/y.md` natively.
      if (href.startsWith("http://") || href.startsWith("https://")) {
        node.properties.target = "_blank";
        node.properties.rel = "nofollow noopener noreferrer";
      }
    });
  };
}

// ── Main render function ──

const baseProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .freeze();

// ── Frontmatter (YAML metadata block at the top of a file) ──

/** Split leading `---\n…\n---` YAML frontmatter off the body. Pattern from the bun howto-db. */
function parseFrontmatter(content: string): { body: string; data: Record<string, unknown> } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { body: content, data: {} };
  let data: Record<string, unknown> = {};
  try {
    const parsed = (Bun as any).YAML.parse(m[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch {
    // malformed YAML → ignore, keep going with empty data
  }
  return { body: content.slice(m[0].length), data };
}

/** Render parsed frontmatter as a metadata card (key/value rows). */
function renderFrontmatter(data: Record<string, unknown>): string {
  const rows = Object.entries(data)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${formatFmValue(v)}</dd>`)
    .join("");
  return `<div class="frontmatter"><div class="frontmatter-head">frontmatter</div><dl>${rows}</dl></div>`;
}

function formatFmValue(v: unknown): string {
  if (v === null || v === undefined) return `<span class="fm-null">∅</span>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `<span class="fm-null">∅</span>`;
    return v.map((x) => `<span class="chip">${escapeHtml(scalarToString(x))}</span>`).join(" ");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `<div class="fm-sub"><span class="fm-sub-key">${escapeHtml(k)}</span> ${formatFmValue(val)}</div>`)
      .join("");
  }
  if (typeof v === "boolean") return `<span class="chip chip-bool">${v}</span>`;
  return escapeHtml(scalarToString(v));
}

function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

// ── Source-file rendering (highlight any code file, not just fenced blocks) ──

const EXT_LANG: Record<string, BundledLanguage | "plaintext"> = {
  md: "markdown", markdown: "markdown",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", py: "python", java: "java",
  clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
  html: "html", htm: "html", css: "css", xml: "xml", svg: "xml",
  go: "go", rs: "rust", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php",
  graphql: "graphql", gql: "graphql", diff: "diff", patch: "diff",
  toml: "toml", zig: "zig", ex: "elixir", exs: "elixir",
  lua: "lua", swift: "swift", kt: "kotlin", kts: "kotlin",
};

/** Pick a Shiki language for a file path (by basename / extension). */
export function languageForFile(filePath: string): string | undefined {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_LANG[ext];
}

/** Render a non-markdown source file as a syntax-highlighted code page (with line numbers). */
export async function renderSourceFile(code: string, filePath: string): Promise<{ html: string; title: string; lang: string }> {
  const hl = await getHighlighter();
  const lang = languageForFile(filePath) ?? "plaintext";
  const highlighted = highlightCode(hl, code, lang);
  const html = `<div class="code-view" data-lang="${escapeHtml(lang)}">${highlighted}</div>`;
  return { html, title: path.basename(filePath), lang };
}

export async function renderMarkdown(content: string, opts: RenderOptions = {}): Promise<{ html: string; toc: TocItem[]; title: string }> {
  const hl = await getHighlighter();

  // Strip leading YAML frontmatter, render it separately as a metadata card.
  const { body, data } = parseFrontmatter(content);
  let processed = body;
  const metaHtml = Object.keys(data).length ? renderFrontmatter(data) : "";

  // Title: frontmatter title/name wins, else first H1, else "Untitled"
  const titleMatch = processed.match(/^#\s+(.+)$/m);
  const title = String(
    data.title || data.name || (titleMatch ? titleMatch[1].trim() : "Untitled"),
  );

  // Mermaid
  if (processed.includes("```mermaid")) {
    processed = await preprocessMermaid(processed);
  }

  // KaTeX
  if (processed.includes("$")) {
    processed = processKaTeX(processed);
  }

  const toc: TocItem[] = [];
  const processor = baseProcessor()
    .use(rehypeHeadingIds(toc))
    .use(rehypeLinkTransform())
    .use(rehypeShiki(hl))
    .use(rehypeStringify, { allowDangerousHtml: true });

  const result = await processor.process(processed);
  return { html: metaHtml + String(result), toc, title };
}

// ── HTML template ──

export function wrapHtml(body: string, toc: TocItem[], title: string, opts: RenderOptions = {}): string {
  const tocHtml = toc.length > 0
    ? `<aside class="toc"><h3>Contents</h3><ul>${toc.map(t =>
        `<li class="toc-${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`
      ).join("")}</ul></aside>`
    : "";

  const breadcrumbHtml = buildBreadcrumb(opts);
  const tabsHtml = buildTabs(opts);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.37/dist/katex.min.css">
  <style>
    :root {
      --bg: #ffffff; --fg: #1d2331; --muted: #717684;
      --border: #e5e7eb; --surface: #f9fafb; --accent: #3b82f6;
      --code-bg: #f6f8fa; --link: #2563eb;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e;
        --border: #30363d; --surface: #161b22; --accent: #58a6ff;
        --code-bg: #161b22; --link: #58a6ff;
      }
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      color: var(--fg); background: var(--bg);
      max-width: 1200px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem;
      line-height: 1.7; font-size: 17px;
    }
    /* Breadcrumb — filesystem path above the document */
    .breadcrumb {
      font-size: 0.82em; color: var(--muted); margin-bottom: 1.5rem;
      padding-bottom: 0.6rem; border-bottom: 1px solid var(--border);
      word-break: break-all; line-height: 1.6;
    }
    .breadcrumb a { color: var(--muted); }
    .breadcrumb a:hover { color: var(--link); text-decoration: none; }
    .breadcrumb .sep { margin: 0 0.4em; opacity: 0.45; }
    .breadcrumb .crumb-current { color: var(--fg); font-weight: 600; }
    /* View tabs — Preview / Source / Code / Raw */
    .tabs { display: flex; gap: 0.25rem; margin: -0.5rem 0 1.75rem; border-bottom: 1px solid var(--border); }
    .tabs .tab {
      padding: 0.45em 0.9em; font-size: 0.85em; color: var(--muted); text-decoration: none;
      border-bottom: 2px solid transparent; margin-bottom: -1px; border-radius: 6px 6px 0 0;
    }
    .tabs .tab:hover { color: var(--fg); background: var(--surface); text-decoration: none; }
    .tabs .tab.active { color: var(--fg); font-weight: 600; border-bottom-color: var(--accent); }
    /* Git history view — GitHub-style timeline */
    .githist { margin: 0; }
    .githist .gh-empty { color: var(--muted); }
    .githist .gh-group { margin-bottom: 0.5rem; }
    .githist .gh-date {
      font-size: 0.85em; font-weight: 600; color: var(--muted);
      margin: 0 0 0.75rem; padding-left: 2.1em; position: relative; line-height: 1.2;
    }
    .githist .gh-date::before {
      content: ""; position: absolute; left: 4px; top: 50%; transform: translateY(-50%);
      width: 10px; height: 10px; border-radius: 2px; background: var(--border);
    }
    .githist .gh-list { list-style: none; margin: 0 0 1.25rem; padding: 0; position: relative; }
    .githist .gh-list::before {
      content: ""; position: absolute; left: 8px; top: -0.5rem; bottom: -0.75rem; width: 2px; background: var(--border);
    }
    .githist .gh-item { position: relative; padding-left: 2.1em; margin-bottom: 0.6rem; }
    .githist .gh-item:last-child { margin-bottom: 0; }
    .githist .gh-dot {
      position: absolute; left: 4px; top: 1.05em; width: 10px; height: 10px; border-radius: 50%;
      background: var(--bg); border: 2px solid var(--muted); box-sizing: border-box;
    }
    .githist .gh-card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg); overflow: hidden; }
    .githist .gh-row { display: flex; align-items: flex-start; gap: 0.7em; padding: 0.7em 1em; cursor: pointer; }
    .githist .gh-row:hover { background: var(--surface); }
    .githist .gh-chevron { color: var(--muted); transition: transform 0.15s ease; line-height: 1.6; flex-shrink: 0; font-size: 1.1em; }
    .githist .gh-item.open .gh-chevron { transform: rotate(90deg); }
    .githist .gh-main { flex: 1 1 auto; min-width: 0; }
    .githist .gh-msg { font-weight: 600; margin-bottom: 0.15em; word-break: break-word; }
    .githist .gh-sub { font-size: 0.82em; color: var(--muted); }
    .githist .gh-actions { display: flex; align-items: center; gap: 0.5em; flex-shrink: 0; }
    .githist .gh-hash {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8em;
      background: var(--code-bg); border: 1px solid var(--border); padding: 0.15em 0.55em; border-radius: 6px; color: var(--muted);
    }
    .githist .gh-row.htmx-request .gh-chevron { opacity: 0.4; }
    /* Accordion: diff hidden until the row is opened */
    .githist .gh-diff { display: none; border-top: 1px solid var(--border); }
    .githist .gh-item.open .gh-diff { display: block; }
    .githist .gh-diff .diff { border: none; border-radius: 0; }
    /* History, code & directory views span the full content width */
    .layout:has(.githist) .prose, .layout:has(.code-view) .prose, .layout:has(.ghdir) .prose { max-width: none; }
    /* Unified diff rendering */
    .diff { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.5em 0; overflow-x: auto; font-size: 12.5px; line-height: 1.5; margin: 0; }
    .diff .dline { display: block; padding: 0 1em; white-space: pre; }
    .diff .d-add { background: rgba(46,160,67,0.18); }
    .diff .d-del { background: rgba(248,81,73,0.18); }
    .diff .d-hunk { color: var(--accent); }
    .diff .d-file, .diff .d-meta { color: var(--muted); }
    /* Directory listing — GitHub-style file list */
    .ghdir { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .ghdir-row { display: flex; align-items: center; gap: 0.6em; padding: 0.5em 1em; border-bottom: 1px solid var(--border); color: var(--fg); text-decoration: none; font-size: 0.95em; }
    .ghdir-row:last-child { border-bottom: none; }
    .ghdir-row:hover { background: var(--surface); text-decoration: none; }
    .ghdir-ico { display: inline-flex; flex-shrink: 0; }
    .ghdir-ico svg { width: 1.05em; height: 1.05em; vertical-align: middle; }
    .ghdir-ico-dir svg { fill: var(--accent); }
    .ghdir-ico-file svg { fill: var(--muted); }
    .ghdir-name { color: var(--link); flex: 0 1 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ghdir-row:hover .ghdir-name { text-decoration: underline; }
    .ghdir-commit { flex: 1 1 auto; min-width: 0; margin-left: 1.5em; font-size: 0.85em; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ghdir-age { margin-left: auto; font-size: 0.82em; color: var(--muted); white-space: nowrap; padding-left: 1.5em; }
    /* git-ignored entries are dimmed */
    .ghdir-ignored { opacity: 0.38; }
    .ghdir-ignored .ghdir-name { color: var(--muted); }
    /* Two-column layout: content + sticky TOC sidebar on the right */
    .layout { display: flex; gap: 2.5rem; align-items: flex-start; }
    .prose { flex: 1 1 auto; min-width: 0; max-width: 820px; }
    h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin-top: 2em; margin-bottom: 0.5em; position: relative; }
    h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin-top: 0; }
    h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .heading-anchor { position: absolute; left: -1.5em; opacity: 0; font-size: 0.8em; padding-right: 0.5em; }
    .heading-anchor::before { content: "#"; }
    h1:hover .heading-anchor, h2:hover .heading-anchor, h3:hover .heading-anchor,
    h4:hover .heading-anchor, h5:hover .heading-anchor, h6:hover .heading-anchor { opacity: 0.5; }
    p { margin: 0 0 1em; }
    img { max-width: 100%; border-radius: 8px; }
    blockquote {
      border-left: 4px solid var(--accent); background: var(--surface);
      margin: 1em 0; padding: 0.75em 1em; border-radius: 0 8px 8px 0;
    }
    blockquote p:last-child { margin-bottom: 0; }
    pre { background: var(--code-bg); border-radius: 8px; padding: 1em; overflow-x: auto; font-size: 14px; }
    pre code { background: none; padding: 0; font-size: inherit; }
    code { background: var(--code-bg); padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid var(--border); padding: 0.5em 0.75em; text-align: left; }
    th { background: var(--surface); font-weight: 600; }
    tr:nth-child(even) { background: var(--surface); }
    hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
    ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
    li { margin: 0.25em 0; }
    .toc {
      flex: 0 0 230px; width: 230px; align-self: flex-start;
      position: sticky; top: 1.5rem; max-height: calc(100vh - 3rem); overflow-y: auto;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 1em 1.25em;
    }
    .toc h3 { margin: 0 0 0.5em; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .toc ul { list-style: none; padding: 0; margin: 0; }
    .toc li { margin: 0.2em 0; line-height: 1.4; }
    .toc .toc-3 { padding-left: 1.2em; }
    .toc a { color: var(--muted); font-size: 0.85em; }
    .toc a:hover { color: var(--link); }
    /* Stack to single column on narrow screens — TOC moves above the content */
    @media (max-width: 900px) {
      .layout { flex-direction: column; gap: 1.5rem; }
      .toc { order: -1; position: static; width: auto; flex-basis: auto; max-height: none; }
    }
    .mermaid-diagram { margin: 1em 0; text-align: center; }
    .mermaid-diagram svg { max-width: 100%; height: auto; }
    /* Frontmatter — YAML metadata card above the document */
    .frontmatter {
      margin: 0 0 2rem; border: 1px solid var(--border); border-radius: 8px;
      background: var(--surface); overflow: hidden; font-size: 0.92em;
    }
    .frontmatter-head {
      font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
      color: var(--muted); padding: 0.5em 1em; border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--fg) 4%, transparent);
    }
    .frontmatter dl { display: grid; grid-template-columns: max-content 1fr; gap: 0; margin: 0; }
    .frontmatter dt {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
      font-weight: 600; color: var(--muted); padding: 0.5em 1em; white-space: nowrap;
      border-bottom: 1px solid var(--border); border-right: 1px solid var(--border);
    }
    .frontmatter dd { margin: 0; padding: 0.5em 1em; border-bottom: 1px solid var(--border); min-width: 0; word-break: break-word; }
    .frontmatter dt:nth-last-of-type(1), .frontmatter dd:nth-last-of-type(1) { border-bottom: none; }
    .frontmatter .chip {
      display: inline-block; background: var(--code-bg); border: 1px solid var(--border);
      border-radius: 999px; padding: 0.05em 0.6em; margin: 0.1em 0.15em 0.1em 0; font-size: 0.85em;
    }
    .frontmatter .chip-bool { font-family: ui-monospace, monospace; }
    .frontmatter .fm-null { color: var(--muted); opacity: 0.6; }
    .frontmatter .fm-sub { padding: 0.05em 0; }
    .frontmatter .fm-sub-key {
      font-family: ui-monospace, monospace; font-size: 0.85em; color: var(--muted); font-weight: 600;
    }
    /* Whole-file code view: line numbers (full-width handled above) */
    .code-view { margin: 0; }
    .code-view .shiki {
      padding: 1em 0; font-size: 13px; line-height: 1.55;
      border: 1px solid var(--border); overflow-x: auto;
    }
    .code-view code { counter-reset: line; display: block; }
    .code-view .line {
      display: inline-block; width: 100%; padding: 0 1.5em 0 0;
    }
    .code-view .line::before {
      counter-increment: line; content: counter(line);
      display: inline-block; width: 3em; margin-right: 1.25em; padding-right: 0.5em;
      text-align: right; color: var(--muted); opacity: 0.55;
      border-right: 1px solid var(--border); user-select: none;
    }
    .code-view .line:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .katex-display { margin: 1em 0; overflow-x: auto; }
    .shiki { border-radius: 8px; }
    @media (prefers-color-scheme: dark) {
      .shiki, .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }
    }
  </style>
</head>
<body>
${breadcrumbHtml}
${tabsHtml}
<div class="layout">
<article class="prose">
${body}
</article>
${tocHtml}
</div>
</body>
</html>`;
}

// ── Breadcrumb ──

// Octicons git-branch (16px), inline + currentColor so it themes with the breadcrumb.
const GIT_ICON = `<svg class="git-root" viewBox="0 0 16 16" width="1em" height="1em" fill="#f05133" aria-hidden="true" title="git repository" style="vertical-align:-0.12em;margin-right:0.25em"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"></path></svg>`;

/** Build the view-switcher tab bar for daemon-served files & directories. */
function buildTabs(opts: RenderOptions): string {
  if (!opts.daemon || !opts.filePath) return "";
  const base = escapeHtml(encodeURI(opts.filePath));
  let isDir = false;
  try { isDir = fs.statSync(opts.filePath).isDirectory(); } catch {}

  // [label, view-id, href]
  let tabs: [string, string, string][];
  let current: string;
  if (isDir) {
    current = opts.view || "files";
    tabs = [["Files", "files", base]];
    if (inGitRepo(opts.filePath)) tabs.push(["History", "history", `${base}?view=history`]);
  } else {
    const isMd = /\.(md|markdown)$/i.test(opts.filePath);
    current = opts.view || (isMd ? "preview" : "code");
    tabs = isMd
      ? [["Preview", "preview", base], ["Source", "source", `${base}?view=source`]]
      : [["Code", "code", base]];
    if (inGitRepo(opts.filePath)) tabs.push(["History", "history", `${base}?view=history`]);
    tabs.push(["Raw", "raw", `${base}?view=raw`]);
  }

  const items = tabs.map(([label, view, href]) => {
    const active = view === current ? " active" : "";
    return `<a class="tab${active}" href="${href}">${label}</a>`;
  }).join("");

  return `<nav class="tabs">${items}</nav>`;
}

/** A directory is a git root if it directly contains a `.git` entry. */
function isGitRoot(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, ".git")); } catch { return false; }
}

/** Is the path inside a git working tree (walks up to the filesystem root)? */
function inGitRepo(filePath: string): boolean {
  let dir: string;
  try { dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath); }
  catch { dir = path.dirname(filePath); }
  for (let i = 0; i < 64; i++) {
    if (isGitRoot(dir)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Build a clickable filesystem-path breadcrumb above the document.
 *  Directory segments that are git roots get a git-branch icon. */
export function buildBreadcrumb(opts: RenderOptions): string {
  if (!opts.filePath) return "";
  const parts = opts.filePath.split("/").filter(Boolean);
  if (parts.length === 0) return "";

  const sep = `<span class="sep">›</span>`;
  const link = (abs: string, inner: string) =>
    opts.daemon ? `<a href="${escapeHtml(encodeURI(abs))}">${inner}</a>` : inner;
  const icon = (dir: string) => (isGitRoot(dir) ? GIT_ICON : "");

  // Root ("/") segment first.
  const pieces: string[] = [link("/", "/")];
  let acc = "";
  parts.forEach((part, i) => {
    acc += "/" + part;
    const inner = icon(acc) + escapeHtml(part);
    if (i === parts.length - 1) {
      pieces.push(`<span class="crumb-current">${inner}</span>`);
    } else {
      pieces.push(link(acc, inner));
    }
  });

  return `<nav class="breadcrumb">${pieces.join(sep)}</nav>`;
}

// ── Utilities ──

function getTextContent(node: Element): string {
  let text = "";
  function extract(n: any) {
    if (n.type === "text" && n.value) text += n.value;
    else if (n.children) n.children.forEach(extract);
  }
  extract(node);
  return text;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
