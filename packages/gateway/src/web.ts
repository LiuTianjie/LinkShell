import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebOptions {
  /** Override bundled assets for development, or disable the web client. */
  directory?: string | false;
  /** Only public account configuration belongs in the browser. */
  account?: { url: string; anonKey: string };
  previewOrigin?: string;
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
};

export function webHandler(options: WebOptions = {}) {
  const directory = options.directory === false ? undefined : options.directory ??
    ["../web-client", "../../../web-client"].map((path) => fileURLToPath(new URL(path, import.meta.url)))
      .find((path) => existsSync(join(path, "index.html")));
  // Assets are immutable for this process; an allowlist also keeps URL paths away from the filesystem.
  const assets = new Map<string, Buffer>();
  function load(path: string, prefix = "") {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.isDirectory()) load(join(path, item.name), `${prefix}/${item.name}`);
      else if (item.isFile()) assets.set(`${prefix}/${item.name}`, readFileSync(join(path, item.name)));
    }
  }
  if (directory) load(directory);
  return (request: IncomingMessage, response: ServerResponse, path: string | undefined): boolean => {
    if (!assets.has("/index.html") || !path || !["GET", "HEAD"].includes(request.method ?? "")) return false;
    let body: Buffer | string | undefined;
    if (path === "/config.js") {
      const config = {
        deployment: options.account ? "official" : "self-hosted",
        ...(options.account ? { account: { url: options.account.url, anonKey: options.account.anonKey } } : {}),
        ...(options.previewOrigin ? { previewOrigin: options.previewOrigin } : {}),
      };
      body = `window.__LINKSHELL_CONFIG__ = ${JSON.stringify(config).replaceAll("<", "\\u003c")};\n`;
    } else {
      body = assets.get(path === "/" ? "/index.html" : path);
    }
    if (body === undefined) return false;
    response.writeHead(200, {
      "content-type": types[extname(path === "/" ? "/index.html" : path)] ?? "application/octet-stream",
      "content-length": Buffer.byteLength(body),
      "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  };
}
