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

async function resolveWebFile(pathname: string, allowSpaFallback: boolean): Promise<string | null> {
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
    if (allowSpaFallback && (pathname === "/" || extname(pathname) === "")) {
      filePath = join(WEB_DIST, "index.html");
    } else {
      return null; // let the caller 404/proxy the missing asset
    }
  }

  return filePath;
}

async function serveWebFile(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<boolean> {
  try {
    const ext = extname(filePath).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", type);
    // Hashed assets (Vite emits content-hashed filenames) can cache hard;
    // index.html must never be cached so deploys take effect immediately.
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache");
      // lsh_tunnel is an HttpOnly helper cookie for preview subresources. Older
      // builds used Path=/, so stale values are still sent to the LinkShell app
      // shell and even /ws handshakes. Clear it whenever the real app document
      // is served; /tunnel/... responses will set a fresh value when preview is
      // actually opened.
      res.setHeader("Set-Cookie", "lsh_tunnel=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
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

/**
 * Try to serve a concrete web asset without the SPA fallback. This lets the
 * gateway protect its own built assets before tunnel cookie fallback handles a
 * previewed app's absolute assets such as "/assets/app.css".
 */
export async function serveWebAsset(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!hasWeb) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const filePath = await resolveWebFile(pathname, false);
  if (!filePath) return false;
  return serveWebFile(req, res, filePath);
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
  const pathname = decodeURIComponent(url.pathname);
  const filePath = await resolveWebFile(pathname, true);
  if (!filePath) return false;

  return serveWebFile(req, res, filePath);
}
