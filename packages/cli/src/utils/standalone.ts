import { existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

/** Only an entry point physically inside a complete app may claim app-managed updates. */
export function standaloneBundle(entry = process.argv[1] ?? ""): string | undefined {
  let path: string;
  try { path = realpathSync(entry); } catch { return undefined; }
  if (process.platform === "win32") {
    // root/runtime/cli/dist/cli/src/index.js; never trust an environment variable alone.
    const root = dirname(dirname(dirname(dirname(dirname(dirname(path))))));
    if (path.toLowerCase() !== join(root, "runtime/cli/dist/cli/src/index.js").toLowerCase()) return undefined;
    return existsSync(join(root, "standalone.json")) && existsSync(join(root, "runtime/node.exe")) && existsSync(join(root, "LinkShell.exe")) ? root : undefined;
  }
  const marker = ".app/Contents/Resources/runtime/cli/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const app = path.slice(0, index + 4);
  return existsSync(join(app, "Contents/Resources/standalone.json")) && existsSync(join(app, "Contents/MacOS/node")) ? app : undefined;
}
