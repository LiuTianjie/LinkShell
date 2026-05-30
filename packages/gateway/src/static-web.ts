import { existsSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { resolve, join, extname, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// Serves the built web-dashboard SPA from the gateway, so a single deployment
// (and single origin) hosts both the API/WebSocket and the UI. The web is
// optional: if WEB_DIST doesn't exist (e.g. local dev using the Vite dev
// server), the gateway runs API-only and this is a no-op.

const WEB_DIST = process.env.WEB_DIST ?? resolve(process.cwd(), "web");
const hasWeb = existsSync(join(WEB_DIST, "index.html"));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function webEnabled(): boolean {
  return hasWeb;
}

export function webDistPath(): string {
  return WEB_DIST;
}

/**
 * Try to serve a GET/HEAD request from the web dist. Returns true if handled.
 * Place AFTER all API routes so it never shadows them. Unmatched non-asset
 * paths fall back to index.html (SPA client-side routing).
 */
export async function serveWeb(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!hasWeb) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = decodeURIComponent(url.pathname);

  // Path-traversal guard: normalize, then confine to WEB_DIST.
  const candidate = resolve(WEB_DIST, "." + normalize(pathname));
  const inRoot = candidate === WEB_DIST || candidate.startsWith(WEB_DIST + "/");

  let filePath: string | null = null;
  if (inRoot && pathname !== "/") {
    try {
      const s = await stat(candidate);
      if (s.isFile()) filePath = candidate;
    } catch {
      // not a real file
    }
  }

  // SPA fallback: serve index.html for "/" and for any path without a file
  // extension (a client-side route). Missing assets (with an extension) 404.
  if (!filePath) {
    if (pathname === "/" || extname(pathname) === "") {
      filePath = join(WEB_DIST, "index.html");
    } else {
      return false; // let the caller 404 the missing asset
    }
  }

  try {
    const ext = extname(filePath).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", type);
    // Hashed assets (Vite emits content-hashed filenames) can cache hard;
    // index.html must never be cached so deploys take effect immediately.
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache");
    } else {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return true;
    }
    const body = await readFile(filePath);
    res.writeHead(200);
    res.end(body);
    return true;
  } catch {
    return false;
  }
}
