#!/usr/bin/env bun

// edita — open any file or folder in the browser by its real filesystem path.
// Usage: bun cli.ts daemon [port]                     — long-running viewer (path-as-URL)
//        bun cli.ts render <file.md> [output.html]    — render a markdown file to HTML
//        bun cli.ts serve <file-or-dir> [port]        — dev server scoped to a path

import { renderMarkdown, renderSourceFile, wrapHtml, buildBreadcrumb } from "./render";
import path from "path";
import fs from "fs";

const SCRIPTS_DIR = import.meta.dir;
const TMP_DIR = `${SCRIPTS_DIR}/tmp`;
const DAEMON_PID_FILE = `${TMP_DIR}/daemon.pid`;
const DAEMON_PORT_FILE = `${TMP_DIR}/daemon.port`;
const DEFAULT_DAEMON_PORT = 3456;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Read a file's git commit history (most recent first; follows renames).
async function gitLog(filePath: string): Promise<{ hash: string; author: string; date: string; subject: string }[]> {
  // --follow only works for a single file; git rejects it for directories.
  let isDir = false;
  try { isDir = fs.statSync(filePath).isDirectory(); } catch {}
  const cwd = isDir ? filePath : path.dirname(filePath);
  const followArgs = isDir ? [] : ["--follow"];
  const proc = Bun.spawn(
    ["git", "-C", cwd, "log", ...followArgs, "--date=short",
     "--format=%H%x1f%an%x1f%ad%x1f%s", "-n", "200", "--", filePath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) return [];
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [hash = "", author = "", date = "", subject = ""] = line.split("\x1f");
    return { hash, author, date, subject };
  });
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
  const liveReload = `<script>
new EventSource(${JSON.stringify(reloadUrl)}).onmessage = () => location.reload();
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

  async function renderFile(filePath: string, view?: string): Promise<string> {
    const stat = fs.statSync(filePath);
    const isMd = /\.(md|markdown)$/i.test(filePath);
    // Default view: markdown → preview, everything else → code.
    const v = view || (isMd ? "preview" : "code");
    const cacheKey = `${filePath}\0${v}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.mtime === stat.mtimeMs) return cached.html;

    const opts = { filePath, daemon: pathMode, view: v };
    const text = await Bun.file(filePath).text();

    let fullHtml: string;
    if (isMd && v === "preview") {
      const { html, toc, title } = await renderMarkdown(text, opts);
      fullHtml = wrapHtml(html, toc, title, opts);
    } else {
      // Code view: a non-markdown file, or a markdown file's "source" tab.
      const { html, title } = await renderSourceFile(text, filePath);
      fullHtml = wrapHtml(html, [], title, opts);
    }
    cache.set(cacheKey, { html: fullHtml, mtime: stat.mtimeMs });
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

  function notifyFileClients(filePath: string) {
    const set = fileClients.get(filePath);
    if (!set) return;
    for (const c of set) {
      try { c.enqueue("data: reload\n\n"); } catch { set.delete(c); }
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
          notifyFileClients(filePath);
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

  // Returns the directory listing as a body fragment (a `.dirlist` table) — wrapped by
  // wrapHtml() for shared breadcrumb/tabs/styling. absMode → hrefs are real paths (daemon),
  // otherwise static URL paths (base-dir serve mode).
  function renderDirectoryListing(dirPath: string, urlPath: string, absMode = false): string {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    // Include dotfiles/dotdirs too.
    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    const linkFor = (childAbs: string, childUrl: string) =>
      absMode ? encodeURI(childAbs) : childUrl;

    const rows: string[] = [];
    if (urlPath !== "/") {
      const parentAbs = path.dirname(dirPath);
      const parentUrl = path.dirname(urlPath) || "/";
      rows.push(`<tr><td>📁</td><td><a href="${linkFor(parentAbs, parentUrl)}">..</a></td><td></td><td></td></tr>`);
    }
    for (const d of dirs) {
      const href = linkFor(path.join(dirPath, d.name), path.join(urlPath, d.name));
      rows.push(`<tr><td>📁</td><td><a href="${href}">${d.name}/</a></td><td>—</td><td></td></tr>`);
    }
    for (const f of files) {
      const href = linkFor(path.join(dirPath, f.name), path.join(urlPath, f.name));
      const stat = fs.statSync(path.join(dirPath, f.name));
      const size = stat.size < 1024 ? `${stat.size} B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)} KB` : `${(stat.size / 1048576).toFixed(1)} MB`;
      const mtime = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      const icon = f.name.endsWith(".md") ? "📝" : f.name.endsWith(".html") ? "🌐" : "📄";
      rows.push(`<tr><td>${icon}</td><td><a href="${href}">${f.name}</a></td><td>${size}</td><td>${mtime}</td></tr>`);
    }

    return `<table class="dirlist"><thead><tr><th></th><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
<tbody>${rows.join("\n")}</tbody></table>`;
  }

  // Build the git-history body (htmx-expandable diffs) for a file OR directory.
  async function historyBody(resolved: string): Promise<string> {
    const commits = await gitLog(resolved);
    if (!commits.length) return `<div class="githist"><p class="gh-empty">No git history.</p></div>`;
    const base = encodeURI(resolved);
    const htmx = `<script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.6/dist/htmx.min.js"></script>`;
    return `${htmx}<div class="githist"><ol>${commits.map((c) => {
      const h = esc(c.hash);
      return `<li><div class="gh-msg">${esc(c.subject)}</div><div class="gh-meta">` +
        `<button class="gh-difftoggle" hx-get="${base}?view=diff&amp;hash=${h}" ` +
        `hx-target="#d-${h}" hx-swap="innerHTML" hx-trigger="click once">diff</button>` +
        `<span class="gh-hash">${esc(c.hash.slice(0, 9))}</span>` +
        `<span>${esc(c.author)}</span><span>${esc(c.date)}</span></div>` +
        `<div class="gh-diff" id="d-${h}"></div></li>`;
    }).join("")}</ol></div>`;
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

      // Render/serve a file or directory by its real absolute path.
      async function serveAbsPath(resolved: string): Promise<Response> {
        if (!fs.existsSync(resolved)) return new Response(`Not found: ${resolved}`, { status: 404 });
        const st = fs.statSync(resolved);
        const view = url.searchParams.get("view") || undefined;
        const reloadUrl = `/__reload?path=${encodeURIComponent(resolved)}`;
        const htmlPage = (body: string, title: string, v: string) => {
          const html = wrapHtml(body, [], title, { filePath: resolved, daemon: pathMode, view: v });
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
          return htmlPage(renderDirectoryListing(resolved, resolved, true), path.basename(resolved) || "/", "files");
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
        const listingBody = renderDirectoryListing(fsPath, pathname.endsWith("/") ? pathname : pathname + "/");
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
  default:
    console.log(`edita — open any file or folder in the browser

Usage:
  edita daemon [port]                     Long-running viewer; open any file at http://localhost:3456/<abs/path>
  edita daemon status                     Show daemon pid and URL
  edita daemon stop                       Stop running daemon
  edita render <file.md> [output.html]    Render a markdown file to standalone HTML
  edita serve <file-or-dir> [port]        Dev server scoped to a path, with live-reload (default: 3456)

Examples:
  edita daemon                            → open http://localhost:3456/Users/me/project/README.md
  edita render README.md                  → README.html
  edita serve ./docs 4000                 → http://localhost:4000`);
}
