#!/usr/bin/env bun

// edita — open any file or folder in the browser by its real filesystem path.
// Usage: bun cli.ts open <file> [L42-45:comment ...]  — open in the browser (starts daemon)
//        bun cli.ts review start|open|notes|stop      — drive a code-review session
//        bun cli.ts daemon [port]                     — long-running viewer

import { renderMarkdown, renderSourceFile, wrapHtml, buildBreadcrumb } from "./render";
import path from "path";
import fs from "fs";
import os from "os";

const SCRIPTS_DIR = import.meta.dir;
const TMP_DIR = `${SCRIPTS_DIR}/tmp`;
const DAEMON_PID_FILE = `${TMP_DIR}/daemon.pid`;
const DAEMON_PORT_FILE = `${TMP_DIR}/daemon.port`;
const DEFAULT_DAEMON_PORT = 3456;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Octicons (16px) for the directory listing.
const FOLDER_SVG = `<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"></path></svg>`;
const FILE_SVG = `<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"></path></svg>`;

interface Commit { hash: string; author: string; date: string; reldate: string; subject: string }

// Read a file's git commit history (most recent first; follows renames).
async function gitLog(filePath: string): Promise<Commit[]> {
  // --follow only works for a single file; git rejects it for directories.
  let isDir = false;
  try { isDir = fs.statSync(filePath).isDirectory(); } catch {}
  const cwd = isDir ? filePath : path.dirname(filePath);
  const followArgs = isDir ? [] : ["--follow"];
  const proc = Bun.spawn(
    ["git", "-C", cwd, "log", ...followArgs, "--date=short",
     "--format=%H%x1f%an%x1f%ad%x1f%ar%x1f%s", "-n", "200", "--", filePath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) return [];
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [hash = "", author = "", date = "", reldate = "", subject = ""] = line.split("\x1f");
    return { hash, author, date, reldate, subject };
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return (y && m && d) ? `${MONTHS[m - 1]} ${d}, ${y}` : ymd;
}

interface EntryCommit { author: string; reldate: string; date: string; subject: string }

// Per-entry git metadata for a directory listing (GitHub-style): the last commit that
// touched each entry, plus the set of git-ignored names. Empty if not a git work tree.
async function gitDirInfo(dirPath: string, names: string[]): Promise<{ commits: Map<string, EntryCommit>; ignored: Set<string> }> {
  const commits = new Map<string, EntryCommit>();
  const ignored = new Set<string>();
  if (names.length === 0 || names.length > 300) return { commits, ignored };
  const check = Bun.spawn(["git", "-C", dirPath, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  const inside = (await new Response(check.stdout).text()).trim() === "true";
  await check.exited;
  if (!inside) return { commits, ignored };

  // Which entries are git-ignored (one batched call; echoes matched names).
  const ig = Bun.spawn(["git", "-C", dirPath, "check-ignore", ...names], { stdout: "pipe", stderr: "ignore" });
  const igOut = await new Response(ig.stdout).text();
  await ig.exited;
  igOut.trim().split("\n").filter(Boolean).forEach((n) => ignored.add(n));

  // Last commit per tracked entry (skip ignored — git log would be empty anyway).
  await Promise.all(names.map(async (name) => {
    if (ignored.has(name)) return;
    const p = Bun.spawn(
      ["git", "-C", dirPath, "log", "-1", "--date=short", "--format=%an%x1f%ar%x1f%ad%x1f%s", "--", name],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (out) {
      const [author = "", reldate = "", date = "", subject = ""] = out.split("\x1f");
      commits.set(name, { author, reldate, date, subject });
    }
  }));
  return { commits, ignored };
}

// Unified diff for a single file at a given commit (the commit's change to that file).
async function gitShow(filePath: string, hash: string): Promise<string | null> {
  let isDir = false;
  try { isDir = fs.statSync(filePath).isDirectory(); } catch {}
  const cwd = isDir ? filePath : path.dirname(filePath);
  const proc = Bun.spawn(
    ["git", "-C", cwd, "show", "--format=", "--no-color", hash, "--", filePath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return proc.exitCode === 0 ? out : null;
}

// ── Global review session (~/.edita/review-<ts>.md, agent-readable) ──

const EDITA_HOME = path.join(os.homedir(), ".edita");
const ACTIVE_PTR = path.join(EDITA_HOME, "active");

interface Note { path: string; start: number; end: number; comment: string }

/** Path of the currently active review file, or null if no review is in progress. */
function activeReviewFile(): string | null {
  try {
    const p = fs.readFileSync(ACTIVE_PTR, "utf8").trim();
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/** Begin a new review session → fresh ~/.edita/review-<ts>.md, marked active. */
function startReview(): string {
  fs.mkdirSync(EDITA_HOME, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(EDITA_HOME, `review-${ts}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# Review — ${new Date().toISOString()}\n\n`);
  fs.writeFileSync(ACTIVE_PTR, file);
  return file;
}

/** End the active session (keeps the .md file). */
function stopReview() { try { fs.unlinkSync(ACTIVE_PTR); } catch {} }

/** Append a note (file path + line range + comment) to the active review. */
async function addReviewNote(file: string, p: string, start: number, end: number, comment: string) {
  const range = end > start ? `L${start}-${end}` : `L${start}`;
  const block = `## ${p} ${range}\n${comment.trim()}\n\n`;
  await Bun.write(file, (await Bun.file(file).text()) + block);
}

/** Delete the note at `index` (matching readNotes order) and rewrite the .md. */
async function deleteReviewNote(file: string, index: number) {
  const notes = readNotes(file);
  if (index < 0 || index >= notes.length) return;
  notes.splice(index, 1);
  const header = (fs.readFileSync(file, "utf8").match(/^# .*\n/)?.[0] ?? "# Review\n") + "\n";
  const body = notes.map((n) => {
    const range = n.end > n.start ? `L${n.start}-${n.end}` : `L${n.start}`;
    return `## ${n.path} ${range}\n${n.comment.trim()}\n\n`;
  }).join("");
  await Bun.write(file, header + body);
}

/** Parse a review .md into notes. */
function readNotes(file: string | null): Note[] {
  if (!file || !fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, "utf8");
  return txt.split(/\n(?=## )/).flatMap((block) => {
    const m = block.match(/^## (.+?) L(\d+)(?:-(\d+))?\n([\s\S]*)$/);
    if (!m) return [];
    return [{ path: m[1]!, start: +m[2]!, end: m[3] ? +m[3] : +m[2]!, comment: m[4]!.trim() }];
  });
}

function noteRange(n: Note): string { return n.end > n.start ? `L${n.start}–L${n.end}` : `L${n.start}`; }

const CHECKLIST_ICON = `<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M2.5 1.75v11.5c0 .138.112.25.25.25h3.17a.75.75 0 0 1 0 1.5H2.75A1.75 1.75 0 0 1 1 13.25V1.75C1 .784 1.784 0 2.75 0h8.5C12.216 0 13 .784 13 1.75v7.736a.75.75 0 0 1-1.5 0V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13.274 9.537-4.557 4.45a.75.75 0 0 1-1.055-.008l-1.943-1.95a.75.75 0 0 1 1.062-1.058l1.419 1.425 4.026-3.932a.75.75 0 1 1 1.048 1.073ZM4.75 4h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM4 7.75A.75.75 0 0 1 4.75 7h2a.75.75 0 0 1 0 1.5h-2A.75.75 0 0 1 4 7.75Z"></path></svg>`;

// Floating review toggle icon (top-right). Off → start; on → finish, with a note-count badge.
function reviewTopHtml(active: boolean, count: number): string {
  if (!active) {
    return `<button class="rv-toggle" title="Start review" data-on-click="@post('/__review/start')">${CHECKLIST_ICON}</button>`;
  }
  return `<button class="rv-toggle rv-toggle-on" title="Reviewing — click to finish" data-on-click="@post('/__review/stop')">${CHECKLIST_ICON}<b class="rv-badge" id="rv-count">${count}</b></button>`;
}

// Right sidebar (review active): line-selection composer + accumulated notes across files.
function reviewBarHtml(currentFile: string, notes: Note[]): string {
  const addUrl = `/__review/add?path=${encodeURIComponent(currentFile)}`;
  const base = esc(path.basename(currentFile));
  const compose =
    `<div class="rv-compose" data-show="$rvStart>0">` +
    `<div class="rv-loc"><span class="rv-loc-file">${base}</span> ` +
    `<span class="rv-loc-range" data-text="$rvStart==$rvEnd ? ('L'+$rvStart) : ('L'+Math.min($rvStart,$rvEnd)+'–L'+Math.max($rvStart,$rvEnd))"></span></div>` +
    `<textarea class="rv-text" data-bind="rvComment" placeholder="Note for these lines…"></textarea>` +
    `<div class="rv-actions">` +
    `<button class="rv-save" data-on-click="@post('${addUrl}')" data-attr="{disabled: !$rvComment}">Add note</button>` +
    `<button class="rv-cancel" data-on-click="$rvStart=0;$rvEnd=0;$rvComment=''">Clear</button>` +
    `</div></div>` +
    `<p class="rv-hint" data-show="$rvStart==0">Click a line number to attach a note (shift-click to extend the range).</p>`;
  return `<aside class="review-bar"><div class="rv-bar-h">Review notes</div>${compose}<div class="rv-notes" id="rv-notes">${notesHtml(notes)}</div></aside>`;
}

// Notes list, grouped by file, with per-note delete — single-line HTML (safe as an SSE fragment).
function notesHtml(notes: Note[]): string {
  if (!notes.length) return `<p class="rv-empty">No notes yet.</p>`;
  // Group by file path, keeping each note's original index (for deletion).
  const groups = new Map<string, { note: Note; idx: number }[]>();
  notes.forEach((note, idx) => {
    if (!groups.has(note.path)) groups.set(note.path, []);
    groups.get(note.path)!.push({ note, idx });
  });
  let out = "";
  for (const [p, items] of groups) {
    items.sort((a, b) => a.note.start - b.note.start);
    out += `<div class="rv-group"><div class="rv-group-h"><a href="${encodeURI(p)}">${esc(path.basename(p))}</a>` +
      `<span class="rv-group-dir">${esc(path.dirname(p))}</span></div>`;
    for (const { note, idx } of items) {
      const comment = esc(note.comment).replace(/\n/g, "<br>");
      // Deep-link opens the file, highlights the lines and shows the note inline (#L..:comment).
      const range = note.end > note.start ? `L${note.start}-${note.end}` : `L${note.start}`;
      const href = `${encodeURI(p)}#${range}:${encodeURIComponent(note.comment)}`;
      out += `<div class="rv-note"><div class="rv-note-top">` +
        `<a class="rv-note-loc" href="${href}">${noteRange(note)}</a>` +
        `<button class="rv-del" data-on-click="@post('/__review/del?i=${idx}')" title="Delete note">×</button>` +
        `</div><div class="rv-note-text">${comment}</div></div>`;
    }
    out += `</div>`;
  }
  return out;
}

// Render a unified diff string as classed, line-per-block HTML.
function renderDiff(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n").map((line) => {
    let cls = "";
    if (line.startsWith("diff ") || line.startsWith("index ")) cls = "d-meta";
    else if (line.startsWith("+++") || line.startsWith("---")) cls = "d-file";
    else if (line.startsWith("@@")) cls = "d-hunk";
    else if (line.startsWith("+")) cls = "d-add";
    else if (line.startsWith("-")) cls = "d-del";
    return `<span class="dline ${cls}">${esc(line) || " "}</span>`;
  });
  return `<pre class="diff"><code>${lines.join("")}</code></pre>`;
}

// Inject live-reload script that subscribes to /__reload (optionally with ?path=<abs>)
function withReload(html: string, reloadUrl: string = "/__reload"): string {
  // A plain "reload" message reloads; any other payload is a URL to navigate to
  // (used when the viewed file is deleted → go to its folder instead of 404-reloading).
  const liveReload = `<script>
new EventSource(${JSON.stringify(reloadUrl)}).onmessage = (e) => { if (e.data && e.data !== "reload") location.href = e.data; else location.reload(); };
</script>`;
  return html.replace("</body>", `${liveReload}\n</body>`);
}

// ── Render command ──

async function render(inputPath: string, outputPath?: string) {
  const absInput = path.resolve(inputPath);
  if (!fs.existsSync(absInput)) {
    console.error(`File not found: ${absInput}`);
    process.exit(1);
  }

  const md = await Bun.file(absInput).text();
  const opts = { filePath: absInput, daemon: false };
  const { html, toc, title } = await renderMarkdown(md, opts);
  const fullHtml = wrapHtml(html, toc, title, opts);

  const outPath = outputPath || absInput.replace(/\.md$/, ".html");
  await Bun.write(outPath, fullHtml);
  console.log(`Rendered: ${outPath}`);
}

// ── Serve command ──

async function serve(target: string | null, port: number) {
  const absTarget = target ? path.resolve(target) : "";
  const stat = target ? fs.statSync(absTarget) : null;
  const isDir = stat ? stat.isDirectory() : false;
  const baseDir: string | null = target ? (isDir ? absTarget : path.dirname(absTarget)) : null;
  // Daemon (no baseDir) serves files at their real path → breadcrumb links to real paths.
  const pathMode = !baseDir;

  console.log(`[edita] Starting server on http://localhost:${port}`);
  if (target) console.log(`[edita] ${isDir ? "Directory" : "File"}: ${absTarget}`);
  else console.log(`[edita] Daemon mode — open any file directly: http://localhost:${port}/<absolute/path>`);

  // Cache rendered pages (plain HTML — reload script injected per-request)
  const cache = new Map<string, { html: string; mtime: number }>();

  // Review scaffolding shared by every page in daemon mode (top bar always; sidebar when active).
  function reviewOpts(filePath: string) {
    if (!pathMode) return { datastar: false } as const;
    const file = activeReviewFile();
    const notes = readNotes(file);
    const active = !!file;
    return {
      datastar: true,
      reviewActive: active,
      reviewTopHtml: reviewTopHtml(active, notes.length),
      reviewBarHtml: active ? reviewBarHtml(filePath, notes) : "",
    };
  }

  async function renderFile(filePath: string, view?: string): Promise<string> {
    const stat = fs.statSync(filePath);
    const isMd = /\.(md|markdown)$/i.test(filePath);
    // Default view: markdown → preview, everything else → code.
    const v = view || (isMd ? "preview" : "code");
    const rv = reviewOpts(filePath);
    // Pages can't be cached while a review is active (notes/markers change without mtime).
    const cacheKey = `${filePath}\0${v}`;
    if (!rv.reviewActive) {
      const cached = cache.get(cacheKey);
      if (cached && cached.mtime === stat.mtimeMs) return cached.html;
    }

    const opts = { filePath, daemon: pathMode, view: v, ...rv };
    const text = await Bun.file(filePath).text();

    let fullHtml: string;
    if (isMd && v === "preview") {
      const { html, toc, title } = await renderMarkdown(text, opts);
      fullHtml = wrapHtml(html, toc, title, opts);
    } else {
      // Code view (non-markdown file, or a markdown file's "source" tab).
      // In review mode, lines are clickable; lines already noted get a gutter marker.
      const reviewed = new Set<number>();
      if (rv.reviewActive) for (const n of readNotes(activeReviewFile())) {
        if (n.path === filePath) for (let i = n.start; i <= n.end; i++) reviewed.add(i);
      }
      const { html: codeHtml, title } = await renderSourceFile(text, filePath, { interactive: !!rv.reviewActive, reviewed });
      fullHtml = wrapHtml(codeHtml, [], title, opts);
    }
    if (!rv.reviewActive) cache.set(cacheKey, { html: fullHtml, mtime: stat.mtimeMs });
    return fullHtml;
  }

  // SSE clients for live-reload (directory-wide + per-file)
  const clients = new Set<ReadableStreamDefaultController>();
  const fileClients = new Map<string, Set<ReadableStreamDefaultController>>();
  const fileWatchers = new Map<string, fs.FSWatcher>();

  function notifyClients() {
    for (const c of clients) {
      try { c.enqueue("data: reload\n\n"); } catch { clients.delete(c); }
    }
  }

  function notifyFileClients(filePath: string, payload = "reload") {
    const set = fileClients.get(filePath);
    if (!set) return;
    for (const c of set) {
      try { c.enqueue(`data: ${payload}\n\n`); } catch { set.delete(c); }
    }
  }

  function ensureFileWatcher(filePath: string) {
    if (fileWatchers.has(filePath)) return;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    try {
      const w = fs.watch(dir, (_ev, filename) => {
        if (filename === base) {
          cache.delete(filePath);
          // Deleted → tell the page to navigate to the folder; otherwise reload in place.
          if (!fs.existsSync(filePath)) notifyFileClients(filePath, encodeURI(path.dirname(filePath)));
          else notifyFileClients(filePath);
        }
      });
      fileWatchers.set(filePath, w);
    } catch {
      // ignore watcher errors (e.g. file in inaccessible dir)
    }
  }

  // Watch for file changes (.md and .html) in baseDir (skip if no baseDir = daemon mode)
  const watcher = baseDir
    ? fs.watch(baseDir, { recursive: true }, (_event, filename) => {
        if (filename && (filename.endsWith(".md") || filename.endsWith(".html"))) {
          const filePath = path.join(baseDir, filename);
          cache.delete(filePath);
          notifyClients();
        }
      })
    : null;

  // MIME types for static files
  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".avif": "image/avif", ".ico": "image/x-icon",
    ".pdf": "application/pdf", ".woff2": "font/woff2", ".woff": "font/woff",
    ".xml": "application/xml", ".txt": "text/plain",
  };

  // Binary / media files — serve raw instead of trying to highlight them as text.
  const BINARY_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
    ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp4", ".webm", ".mp3", ".wav", ".ogg", ".zip", ".gz", ".wasm",
  ]);

  // Returns the directory listing as a GitHub-style body fragment (a `.ghdir` list) —
  // wrapped by wrapHtml() for shared breadcrumb/tabs/styling. absMode → hrefs are real
  // paths (daemon), otherwise static URL paths (base-dir serve mode).
  async function renderDirectoryListing(dirPath: string, urlPath: string, absMode = false): Promise<string> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    // Include dotfiles/dotdirs too.
    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    const linkFor = (childAbs: string, childUrl: string) =>
      absMode ? encodeURI(childAbs) : childUrl;

    // Last commit per entry + git-ignored set (GitHub-style "who/when edited"); empty if not a git tree.
    const { commits, ignored } = await gitDirInfo(dirPath, [...dirs, ...files].map(e => e.name));

    const row = (href: string, name: string, isDir: boolean, fallback = "") => {
      const c = commits.get(name);
      const isIgnored = ignored.has(name);
      const cls = `ghdir-row${isIgnored ? " ghdir-ignored" : ""}`;
      const ico = `<span class="ghdir-ico ghdir-ico-${isDir ? "dir" : "file"}">${isDir ? FOLDER_SVG : FILE_SVG}</span>`;
      const nm = `<span class="ghdir-name">${esc(name)}</span>`;
      const mid = c ? `<span class="ghdir-commit">${esc(c.subject)}</span>` : "";
      const right = c
        ? `<span class="ghdir-age">${esc(c.author)} · ${esc(c.reldate)}</span>`
        : (fallback ? `<span class="ghdir-age">${esc(fallback)}</span>` : "");
      const title = isIgnored ? ` title="git-ignored"`
        : c ? ` title="${esc(c.author)} committed ${esc(c.date)} — ${esc(c.subject)}"` : "";
      return `<a class="${cls}" href="${href}"${title}>${ico}${nm}${mid}${right}</a>`;
    };

    const rows: string[] = [];
    if (urlPath !== "/") {
      rows.push(`<a class="ghdir-row" href="${linkFor(path.dirname(dirPath), path.dirname(urlPath) || "/")}">` +
        `<span class="ghdir-ico ghdir-ico-dir">${FOLDER_SVG}</span><span class="ghdir-name">..</span></a>`);
    }
    for (const d of dirs) {
      rows.push(row(linkFor(path.join(dirPath, d.name), path.join(urlPath, d.name)), d.name, true));
    }
    for (const f of files) {
      const stat = fs.statSync(path.join(dirPath, f.name));
      const mtime = new Date(stat.mtimeMs).toISOString().slice(0, 10);
      rows.push(row(linkFor(path.join(dirPath, f.name), path.join(urlPath, f.name)), f.name, false, mtime));
    }

    return `<div class="ghdir">${rows.join("")}</div>`;
  }

  // Build the git-history body (GitHub-style, htmx-expandable diffs) for a file OR directory.
  async function historyBody(resolved: string): Promise<string> {
    const commits = await gitLog(resolved);
    if (!commits.length) return `<div class="githist"><p class="gh-empty">No git history.</p></div>`;
    const base = encodeURI(resolved);
    const htmx = `<script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.6/dist/htmx.min.js"></script>`;

    // Group consecutive commits by calendar day.
    const groups: { date: string; items: Commit[] }[] = [];
    for (const c of commits) {
      let g = groups[groups.length - 1];
      if (!g || g.date !== c.date) { g = { date: c.date, items: [] }; groups.push(g); }
      g.items.push(c);
    }

    const groupsHtml = groups.map((g) => {
      const items = g.items.map((c) => {
        const h = esc(c.hash);
        // The whole row is an accordion toggle: htmx lazy-loads the diff once,
        // ghToggle() expands/collapses (one open at a time).
        return `<li class="gh-item"><span class="gh-dot"></span><div class="gh-card">` +
          `<div class="gh-row" hx-get="${base}?view=diff&amp;hash=${h}" hx-target="#d-${h}" ` +
          `hx-swap="innerHTML" hx-trigger="click once" onclick="ghToggle(this)">` +
          `<span class="gh-chevron">›</span><div class="gh-main">` +
          `<div class="gh-msg">${esc(c.subject)}</div>` +
          `<div class="gh-sub">${esc(c.author)} committed ${esc(c.reldate)}</div>` +
          `</div><div class="gh-actions"><span class="gh-hash">${esc(c.hash.slice(0, 7))}</span></div>` +
          `</div><div class="gh-diff" id="d-${h}"></div></div></li>`;
      }).join("");
      return `<div class="gh-group"><div class="gh-date">Commits on ${esc(formatDate(g.date))}</div>` +
        `<ol class="gh-list">${items}</ol></div>`;
    }).join("");

    const script = `<script>function ghToggle(row){var item=row.closest('.gh-item');var willOpen=!item.classList.contains('open');document.querySelectorAll('.gh-item.open').forEach(function(i){if(i!==item)i.classList.remove('open');});item.classList.toggle('open',willOpen);}</script>`;
    return `${htmx}${script}<div class="githist">${groupsHtml}</div>`;
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);

      // SSE endpoint for live-reload (?path=<abs> → file-scoped, else dir-scoped)
      if (pathname === "/__reload") {
        const watchPath = url.searchParams.get("path");
        const resolved = watchPath ? path.resolve(watchPath) : null;
        if (resolved) ensureFileWatcher(resolved);
        const stream = new ReadableStream({
          start(controller) {
            if (resolved) {
              let set = fileClients.get(resolved);
              if (!set) { set = new Set(); fileClients.set(resolved, set); }
              set.add(controller);
              req.signal.addEventListener("abort", () => set!.delete(controller));
            } else {
              clients.add(controller);
              req.signal.addEventListener("abort", () => clients.delete(controller));
            }
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
        });
      }

      // Start review → reload so every page enters review mode.
      if (pathname === "/__review/start" && req.method === "POST") {
        startReview();
        return new Response(`event: datastar-execute-script\ndata: script window.location.reload()\n\n`,
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      // Finish review → close the session and open the finished review file.
      if (pathname === "/__review/stop" && req.method === "POST") {
        const file = activeReviewFile();
        stopReview();
        const target = file ? encodeURI(file) : "/";
        return new Response(`event: datastar-execute-script\ndata: script window.location='${target}'\n\n`,
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }

      // Add a note to the active review (Datastar @post) → append to the session .md,
      // reply with SSE that resets the composer, refreshes the notes list + count.
      if (pathname === "/__review/add" && req.method === "POST") {
        const file = activeReviewFile();
        if (!file) return new Response("no active review", { status: 409 });
        const abs = url.searchParams.get("path");
        if (!abs) return new Response("missing path", { status: 400 });
        const resolved = path.resolve(abs);
        let sig: any = {};
        try { const j = await req.json(); sig = j?.datastar ?? j ?? {}; } catch {}
        const start = Math.max(0, Math.floor(Number(sig.rvStart) || 0));
        const end = Math.max(start, Math.floor(Number(sig.rvEnd) || start));
        const comment = String(sig.rvComment ?? "").trim();
        if (!start || !comment) {
          return new Response(`event: datastar-merge-signals\ndata: signals {rvComment: ''}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } });
        }
        await addReviewNote(file, resolved, start, end, comment);
        const notes = readNotes(file);
        const sse =
          `event: datastar-merge-signals\ndata: signals {rvStart: 0, rvEnd: 0, rvComment: ''}\n\n` +
          `event: datastar-merge-fragments\ndata: fragments <div class="rv-notes" id="rv-notes">${notesHtml(notes)}</div>\n\n` +
          `event: datastar-merge-fragments\ndata: fragments <b class="rv-badge" id="rv-count">${notes.length}</b>\n\n`;
        return new Response(sse, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }

      // Delete a note from the active review by its index.
      if (pathname === "/__review/del" && req.method === "POST") {
        const file = activeReviewFile();
        if (!file) return new Response("no active review", { status: 409 });
        const i = parseInt(url.searchParams.get("i") || "-1", 10);
        if (i >= 0) await deleteReviewNote(file, i);
        const notes = readNotes(file);
        const sse =
          `event: datastar-merge-fragments\ndata: fragments <div class="rv-notes" id="rv-notes">${notesHtml(notes)}</div>\n\n` +
          `event: datastar-merge-fragments\ndata: fragments <b class="rv-badge" id="rv-count">${notes.length}</b>\n\n`;
        return new Response(sse, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }

      // Delete a file (tab-bar trash icon) → unlink, then redirect to the parent directory.
      if (pathname === "/__delete" && req.method === "POST") {
        const abs = url.searchParams.get("path");
        if (!abs) return new Response("missing path", { status: 400 });
        const resolved = path.resolve(abs);
        if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
          return new Response("not a file", { status: 400 });
        }
        const parent = path.dirname(resolved);
        try { fs.unlinkSync(resolved); cache.delete(`${resolved}\0code`); cache.delete(`${resolved}\0source`); }
        catch (e: any) { return new Response(`delete failed: ${e.message}`, { status: 500 }); }
        return new Response(`event: datastar-execute-script\ndata: script window.location='${encodeURI(parent)}'\n\n`,
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }

      // Render/serve a file or directory by its real absolute path.
      async function serveAbsPath(resolved: string): Promise<Response> {
        if (!fs.existsSync(resolved)) return new Response(`Not found: ${resolved}`, { status: 404 });
        const st = fs.statSync(resolved);
        const view = url.searchParams.get("view") || undefined;
        const reloadUrl = `/__reload?path=${encodeURIComponent(resolved)}`;
        const htmlPage = (body: string, title: string, v: string) => {
          const html = wrapHtml(body, [], title, { filePath: resolved, daemon: pathMode, view: v, ...reviewOpts(resolved) });
          return new Response(withReload(html, reloadUrl), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        };

        // "Diff" toggle (htmx fragment) → a commit's diff for this file/dir.
        if (view === "diff") {
          const hash = url.searchParams.get("hash") || "";
          if (!/^[0-9a-f]{7,40}$/i.test(hash)) return new Response("bad hash", { status: 400 });
          const diff = await gitShow(resolved, hash);
          const frag = diff ? renderDiff(diff) : `<p class="gh-empty">No diff available.</p>`;
          return new Response(frag, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }

        // Directories: history view, or the listing (default).
        if (st.isDirectory()) {
          if (view === "history") return htmlPage(await historyBody(resolved), path.basename(resolved) || "/", "history");
          return htmlPage(await renderDirectoryListing(resolved, resolved, true), path.basename(resolved) || "/", "files");
        }

        // Files.
        const ext = path.extname(resolved).toLowerCase();
        if (BINARY_EXTS.has(ext)) {
          return new Response(Bun.file(resolved), { headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" } });
        }
        if (view === "raw") {
          return new Response(Bun.file(resolved), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        if (view === "history") return htmlPage(await historyBody(resolved), path.basename(resolved), "history");
        try {
          const html = await renderFile(resolved, view);
          return new Response(withReload(html, reloadUrl), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e: any) {
          return new Response(`<pre>Error: ${e.message}</pre>`, { status: 500, headers: { "Content-Type": "text/html" } });
        }
      }

      // Legacy alias: /markdown?path=<abs> → redirect to the clean real-path URL.
      if (pathname === "/markdown") {
        const abs = url.searchParams.get("path");
        if (!abs) {
          return new Response(
            `<!doctype html><meta charset="utf-8"><title>edita</title>
<style>body{font-family:system-ui;max-width:720px;margin:3em auto;padding:0 1em;color:#1d2331}code{background:#f6f8fa;padding:1px 4px;border-radius:3px}</style>
<h1>edita</h1>
<p>Open any file directly by its path: <code>http://localhost:${port}/&lt;absolute/path/to/file&gt;</code></p>
<p>Example: <a href="/etc/hosts">/etc/hosts</a></p>`,
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        return Response.redirect(encodeURI(path.resolve(abs)), 302);
      }

      // Daemon mode (no baseDir): the URL path IS the filesystem path.
      if (!baseDir) {
        return await serveAbsPath(pathname);
      }

      // Single file mode — always render that file
      if (!isDir) {
        try {
          const html = await renderFile(absTarget);
          return new Response(withReload(html), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e: any) {
          return new Response(`<pre>Error: ${e.message}</pre>`, { status: 500, headers: { "Content-Type": "text/html" } });
        }
      }

      // Directory mode — resolve filesystem path
      const fsPath = path.join(baseDir, pathname);

      // Security: prevent path traversal
      if (!fsPath.startsWith(baseDir)) {
        return new Response("Forbidden", { status: 403 });
      }

      // Check if path exists
      if (!fs.existsSync(fsPath)) {
        // Try adding .md extension
        const mdPath = fsPath + ".md";
        if (fs.existsSync(mdPath)) {
          try {
            const html = await renderFile(mdPath);
            return new Response(withReload(html), { headers: { "Content-Type": "text/html; charset=utf-8" } });
          } catch (e: any) {
            return new Response(`<pre>Error: ${e.message}</pre>`, { status: 500, headers: { "Content-Type": "text/html" } });
          }
        }
        return new Response("Not found", { status: 404 });
      }

      const fsStat = fs.statSync(fsPath);

      // Directory → check for index.md, then index.html, then listing
      if (fsStat.isDirectory()) {
        const indexMd = path.join(fsPath, "index.md");
        const indexHtml = path.join(fsPath, "index.html");
        if (fs.existsSync(indexMd)) {
          try {
            const html = await renderFile(indexMd);
            return new Response(withReload(html), { headers: { "Content-Type": "text/html; charset=utf-8" } });
          } catch (e: any) {
            return new Response(`<pre>Error: ${e.message}</pre>`, { status: 500, headers: { "Content-Type": "text/html" } });
          }
        }
        if (fs.existsSync(indexHtml)) {
          return new Response(Bun.file(indexHtml), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        // Directory listing (base-dir serve mode → static URL hrefs)
        const listingBody = await renderDirectoryListing(fsPath, pathname.endsWith("/") ? pathname : pathname + "/");
        const listing = wrapHtml(listingBody, [], path.basename(fsPath) || "/", { filePath: fsPath, daemon: false });
        return new Response(listing, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // Markdown files → render
      if (fsPath.endsWith(".md")) {
        try {
          const html = await renderFile(fsPath);
          return new Response(withReload(html), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e: any) {
          return new Response(`<pre>Error: ${e.message}</pre>`, { status: 500, headers: { "Content-Type": "text/html" } });
        }
      }

      // HTML files → serve as-is
      if (fsPath.endsWith(".html") || fsPath.endsWith(".htm")) {
        return new Response(Bun.file(fsPath), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      // All other files — static serving with correct MIME type
      const ext = path.extname(fsPath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      return new Response(Bun.file(fsPath), { headers: { "Content-Type": mime } });
    },
  });

  console.log(`[edita] Server running at http://localhost:${server.port}`);
  if (isDir && baseDir) {
    const mdFiles = fs.readdirSync(baseDir).filter(f => f.endsWith(".md"));
    console.log(`[edita] Files: ${mdFiles.join(", ")}`);
  }
  console.log(`[edita] Live-reload enabled — edit .md files and browser auto-refreshes`);
  if (!baseDir) console.log(`[edita] Open any file:  http://localhost:${server.port}/<absolute/path>`);

  // Cleanup on exit
  const closeAll = () => {
    if (watcher) watcher.close();
    for (const w of fileWatchers.values()) { try { w.close(); } catch {} }
    server.stop();
  };
  process.on("SIGINT", () => { closeAll(); process.exit(0); });
  process.on("SIGTERM", () => { closeAll(); process.exit(0); });
}

// ── Daemon command ── (long-running, no base dir, serves files at their real path)

async function daemonStart(port: number) {
  // If a daemon is already running on this port, exit gracefully.
  if (fs.existsSync(DAEMON_PID_FILE)) {
    const oldPid = parseInt(await Bun.file(DAEMON_PID_FILE).text());
    if (oldPid && isAlive(oldPid)) {
      console.log(`[edita] Daemon already running (pid ${oldPid})`);
      return;
    }
  }
  await Bun.write(DAEMON_PID_FILE, String(process.pid));
  await Bun.write(DAEMON_PORT_FILE, String(port));
  await serve(null, port);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function daemonStatus() {
  if (!fs.existsSync(DAEMON_PID_FILE)) { console.log("[edita] daemon: not running"); return; }
  const pid = parseInt(await Bun.file(DAEMON_PID_FILE).text());
  const port = fs.existsSync(DAEMON_PORT_FILE) ? (await Bun.file(DAEMON_PORT_FILE).text()).trim() : "?";
  if (pid && isAlive(pid)) {
    console.log(`[edita] daemon: running  pid=${pid}  http://localhost:${port}`);
    console.log(`           open file:   http://localhost:${port}/<absolute/path>`);
  } else {
    console.log(`[edita] daemon: stale pid file (pid ${pid} not alive)`);
  }
}

async function daemonStop() {
  if (!fs.existsSync(DAEMON_PID_FILE)) { console.log("[edita] daemon: not running"); return; }
  const pid = parseInt(await Bun.file(DAEMON_PID_FILE).text());
  if (pid && isAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); console.log(`[edita] daemon: stopped (pid ${pid})`); }
    catch (e: any) { console.error(`[edita] daemon: kill failed: ${e.message}`); }
  } else {
    console.log("[edita] daemon: not alive");
  }
  try { fs.unlinkSync(DAEMON_PID_FILE); } catch {}
  try { fs.unlinkSync(DAEMON_PORT_FILE); } catch {}
}

// ── Open command ── (open a file/folder in the browser via the daemon)

// Build a URL hash from line specs like "L42-45:fix naming" → "L42-45:fix%20naming",
// joined with ";". The comment part is URL-encoded so spaces/punctuation survive.
function buildLineHash(specs: string[]): string {
  const parts = specs.map((s) => {
    const m = s.match(/^L?(\d+)(?:-(\d+))?(?:C(\d+)-(\d+))?(?:@([^:]*))?(?::([\s\S]*))?$/);
    if (!m) return "";
    let out = m[2] ? `L${m[1]}-${m[2]}` : `L${m[1]}`;
    if (m[3] && m[4]) out += `C${m[3]}-${m[4]}`;
    if (m[5]) out += `@${encodeURIComponent(m[5])}`;
    if (m[6]) out += `:${encodeURIComponent(m[6])}`;
    return out;
  }).filter(Boolean);
  return parts.length ? "#" + parts.join(";") : "";
}

async function openCmd(target: string, lineSpecs: string[]) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) { console.error(`Not found: ${abs}`); process.exit(1); }

  // Ensure a daemon is up; if not, start one detached and wait for its port file.
  let pid = fs.existsSync(DAEMON_PID_FILE) ? parseInt(await Bun.file(DAEMON_PID_FILE).text()) : 0;
  if (!pid || !isAlive(pid)) {
    console.log("[edita] starting daemon…");
    const proc = Bun.spawn(["bun", `${SCRIPTS_DIR}/cli.ts`, "daemon"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    proc.unref();
    for (let i = 0; i < 40 && !(fs.existsSync(DAEMON_PID_FILE) && isAlive(parseInt(await Bun.file(DAEMON_PID_FILE).text()))); i++) {
      await Bun.sleep(100);
    }
  }
  const port = fs.existsSync(DAEMON_PORT_FILE) ? (await Bun.file(DAEMON_PORT_FILE).text()).trim() : String(DEFAULT_DAEMON_PORT);

  const url = `http://localhost:${port}${encodeURI(abs)}${buildLineHash(lineSpecs)}`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" }); } catch {}
  console.log(url);
}


// ── Main ──

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "render": {
    const input = args[0];
    const output = args[1];
    if (!input) { console.error("Usage: edita render <file.md> [output.html]"); process.exit(1); }
    await render(input, output);
    break;
  }
  case "serve": {
    const target = args[0] || ".";
    const port = parseInt(args[1] || "3456");
    await serve(target, port);
    break;
  }
  case "daemon": {
    const sub = args[0];
    if (sub === "stop") { await daemonStop(); break; }
    if (sub === "status") { await daemonStatus(); break; }
    const port = parseInt(args[0] || String(DEFAULT_DAEMON_PORT));
    await daemonStart(Number.isFinite(port) ? port : DEFAULT_DAEMON_PORT);
    break;
  }
  case "open": {
    const target = args[0];
    if (!target) { console.error("Usage: edita open <file-or-dir> [L42-45[:comment] ...]"); process.exit(1); }
    await openCmd(target, args.slice(1));
    break;
  }
  case "review": {
    const sub = args[0] || "status";
    if (sub === "start") {
      const f = startReview();
      console.log(`[edita] review started → ${f}`);
    } else if (sub === "stop" || sub === "finish") {
      const f = activeReviewFile();
      stopReview();
      console.log(f ? `[edita] review finished → ${f}` : "[edita] no active review");
    } else if (sub === "status") {
      const f = activeReviewFile();
      console.log(f ? `[edita] reviewing → ${f}  (${readNotes(f).length} note(s))` : "[edita] no active review");
    } else if (sub === "path") {
      const f = activeReviewFile();
      if (f) console.log(f); else process.exit(1);
    } else if (sub === "notes" || sub === "show") {
      const f = activeReviewFile();
      if (f) process.stdout.write(await Bun.file(f).text()); else { console.error("[edita] no active review"); process.exit(1); }
    } else if (sub === "open") {
      const f = activeReviewFile();
      if (!f) { console.error("[edita] no active review — run `edita review start`"); process.exit(1); }
      await openCmd(f, args.slice(1));
    } else {
      console.error("Usage: edita review <start|stop|status|open|path|notes>"); process.exit(1);
    }
    break;
  }
  default:
    console.log(`edita — open any file or folder in the browser

Usage:
  edita open <file-or-dir> [L42-45[:comment] ...]   Open in the browser (starts daemon if needed; highlights lines)
  edita review start                                Start a system-wide review session
  edita review open                                 Open the active review file in the browser
  edita review status | path | notes | stop         Inspect / read / finish the review
  edita daemon [port]                               Long-running viewer (default: 3456)
  edita daemon status | stop                        Inspect / stop the daemon
  edita render <file.md> [output.html]              Render a markdown file to standalone HTML
  edita serve <file-or-dir> [port]                  Dev server scoped to a path, with live-reload

Examples:
  edita open src/app.ts L42-45:"fix this" L80       → opens with lines highlighted + annotated
  edita review start && edita open src/app.ts        → review mode; user clicks lines to leave notes
  edita review notes                                → print the collected review for the agent to apply`);
}
