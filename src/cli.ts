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

  async function renderFile(filePath: string): Promise<string> {
    const stat = fs.statSync(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) return cached.html;

    const opts = { filePath, daemon: pathMode };
    const ext = path.extname(filePath).toLowerCase();
    const text = await Bun.file(filePath).text();

    let fullHtml: string;
    if (ext === ".md" || ext === ".markdown") {
      const { html, toc, title } = await renderMarkdown(text, opts);
      fullHtml = wrapHtml(html, toc, title, opts);
    } else {
      // Any other text file → syntax-highlighted code view
      const { html, title } = await renderSourceFile(text, filePath);
      fullHtml = wrapHtml(html, [], title, opts);
    }
    cache.set(filePath, { html: fullHtml, mtime: stat.mtimeMs });
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

  // absMode → hrefs are the file's real path (daemon path-routing mode), so relative
  // links inside rendered docs resolve natively; otherwise hrefs are static URL paths.
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

    // Path breadcrumb (clickable real-path links in daemon/absMode); fall back to a
    // plain heading for the filesystem root or static base-dir listings.
    const crumb = absMode ? buildBreadcrumb({ filePath: dirPath, daemon: true }) : "";
    const header = crumb || `<h1>Index of ${urlPath}</h1>`;

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Index of ${urlPath}</title>
<style>
:root { --bg:#fff; --fg:#1d2331; --muted:#717684; --border:#e5e7eb; --surface:#f9fafb; --link:#2563eb; }
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--border:#30363d;--surface:#161b22;--link:#58a6ff;}}
body{font-family:system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:900px;margin:0 auto;padding:2rem 1.5rem;}
h1{font-size:1.5em;border-bottom:1px solid var(--border);padding-bottom:.3em;}
.breadcrumb{font-size:.95em;margin-bottom:1.5rem;padding-bottom:.6rem;border-bottom:1px solid var(--border);word-break:break-all;line-height:1.6;}
.breadcrumb a{color:var(--muted);} .breadcrumb a:hover{color:var(--link);text-decoration:none;}
.breadcrumb .sep{margin:0 .4em;opacity:.45;} .breadcrumb .crumb-current{color:var(--fg);font-weight:600;}
table{border-collapse:collapse;width:100%;}
th,td{text-align:left;padding:.4em .8em;border-bottom:1px solid var(--border);}
th{background:var(--surface);font-weight:600;font-size:.85em;color:var(--fg);}
a{color:var(--link);text-decoration:none;} a:hover{text-decoration:underline;}
td:first-child{width:1.5em;text-align:center;}
td:nth-child(3),td:nth-child(4){font-size:.85em;color:var(--muted);white-space:nowrap;}
</style></head><body>
${header}
<table><thead><tr><th></th><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
<tbody>${rows.join("\n")}</tbody></table>
</body></html>`;
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
        if (st.isDirectory()) {
          const listing = renderDirectoryListing(resolved, resolved, true);
          return new Response(listing, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const ext = path.extname(resolved).toLowerCase();
        if (BINARY_EXTS.has(ext)) {
          return new Response(Bun.file(resolved), { headers: { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" } });
        }
        try {
          const html = await renderFile(resolved);
          const reloadUrl = `/__reload?path=${encodeURIComponent(resolved)}`;
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
            `<!doctype html><meta charset="utf-8"><title>markdown daemon</title>
<style>body{font-family:system-ui;max-width:720px;margin:3em auto;padding:0 1em;color:#1d2331}code{background:#f6f8fa;padding:1px 4px;border-radius:3px}</style>
<h1>markdown daemon</h1>
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
        // Directory listing
        const listing = renderDirectoryListing(fsPath, pathname.endsWith("/") ? pathname : pathname + "/");
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
