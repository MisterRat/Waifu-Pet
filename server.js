// Local static file server so the renderer can fetch Live2D assets over HTTP
// (file:// XHR/fetch is blocked by CORS in Chromium).
//
// Only a whitelist of folders is served (renderer code, chat UI, vendor libs,
// assets) — not the whole app directory — so main.js, ipc.js, logs etc. are
// never reachable. /models/<name>/... is served from the model roots (see
// models.js), which may live outside the app (next to the .exe, user data).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".moc3": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

// Folders (relative to rootDir) that may be served.
const DEFAULT_ALLOW = ["renderer", "chat", "vendor", "assets"];

/** True when `target` is `root` itself or lives inside it (separator-safe). */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Serves whitelisted folders of `rootDir` on 127.0.0.1 with a random free port.
 * @param {string} rootDir
 * @param {{extraAllow?: string[], modelRoots?: () => string[]}} [opts]
 *   extraAllow: extra folders to serve (e.g. dev tools);
 *   modelRoots: returns the folders that /models/<name>/ is looked up in
 * @returns {Promise<{server: http.Server, port: number, close: () => void}>}
 */
function startStaticServer(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const allowed = [...DEFAULT_ALLOW, ...(opts.extraAllow || [])].map((p) => path.resolve(root, p));
  const isAllowed = (target) => allowed.some((a) => isInside(a, target));
  const getRoots = () => (opts.modelRoots ? opts.modelRoots() : [path.join(root, "models")]).map((r) => path.resolve(r));

  /**
   * Map a URL-relative path to a file. Paths under models/ are resolved against
   * the model roots (first root containing that model folder wins).
   * @returns {{filePath: string, ok: boolean}}
   */
  function resolvePath(rel) {
    const parts = rel.split("/").filter(Boolean);
    if (parts[0] === "models") {
      if (parts.length === 1) return { filePath: null, ok: true, modelList: true };
      const name = parts[1];
      for (const r of getRoots()) {
        const dir = path.join(r, name);
        let isDir = false;
        try {
          isDir = fs.statSync(dir).isDirectory();
        } catch {
          /* not in this root */
        }
        if (!isDir) continue;
        const filePath = path.resolve(dir, ...parts.slice(2));
        return { filePath, ok: isInside(dir, filePath) };
      }
      return { filePath: path.join(getRoots()[0] || root, ...parts.slice(1)), ok: false, missing: true };
    }
    const filePath = path.resolve(root, rel);
    return { filePath, ok: isInside(root, filePath) && isAllowed(filePath) };
  }

  return new Promise((resolve, reject) => {
    let boundPort = 0;

    const server = http.createServer((req, res) => {
      const fail = (code, msg) => {
        if (!res.headersSent) res.writeHead(code, { "Content-Type": "text/plain" });
        res.end(msg);
      };
      try {
        if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed");

        // DNS-rebinding defence: only answer requests addressed to loopback.
        const host = String(req.headers.host || "");
        if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
          return fail(403, "Forbidden");
        }

        const [urlPathRaw, query] = (req.url || "/").split("?");
        // Browsers always ask for this; answer quietly instead of logging a 403.
        if (urlPathRaw === "/favicon.ico") {
          res.writeHead(204);
          return res.end();
        }
        let urlPath;
        try {
          urlPath = decodeURIComponent(urlPathRaw);
        } catch {
          return fail(400, "Bad request");
        }
        if (urlPath.includes("\0")) return fail(400, "Bad request");
        const params = new URLSearchParams(query || "");

        // Normalize as a POSIX path anchored at "/" (collapses ".."), then
        // resolve and verify containment on the real filesystem path.
        const rel = path.posix.normalize("/" + urlPath.replace(/\\/g, "/")).replace(/^\/+/, "");
        const resolved = resolvePath(rel);
        if (resolved.modelList) {
          // /models/?list=1 -> every model folder name across all roots
          const names = new Set();
          for (const r of getRoots()) {
            try {
              for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name);
            } catch {
              /* root doesn't exist */
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify([...names].sort()));
        }
        if (resolved.missing) return fail(404, "Not found");
        if (!resolved.ok) return fail(403, "Forbidden");
        const filePath = resolved.filePath;

        // Directory listing (JSON file names) — used to discover .exp3.json /
        // .motion3.json files.
        if (params.get("list") === "1") {
          return fs.readdir(filePath, (err, entries) => {
            if (err) return fail(404, "Not found");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(entries));
          });
        }

        fs.stat(filePath, (err, stat) => {
          if (err || !stat.isFile()) {
            // Log 404s so asset load failures (e.g. a missing texture) show
            // up in the terminal next to the renderer's [tex] debug line.
            console.log("[server] 404", req.url);
            return fail(404, "Not found");
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Content-Length": stat.size,
            "Cache-Control": "no-cache",
            // Keep other websites from embedding our files via no-cors loads.
            "Cross-Origin-Resource-Policy": "same-origin",
            "X-Content-Type-Options": "nosniff",
          });
          if (req.method === "HEAD") return res.end();
          const stream = fs.createReadStream(filePath);
          stream.on("error", (e) => {
            console.log("[server] read error", req.url, e.message);
            res.destroy();
          });
          res.on("close", () => stream.destroy());
          stream.pipe(res);
        });
      } catch (e) {
        console.log("[server] error", e && e.message);
        fail(500, "Server error");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      boundPort = server.address().port;
      resolve({
        server,
        port: boundPort,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}

module.exports = { startStaticServer, isInside };
