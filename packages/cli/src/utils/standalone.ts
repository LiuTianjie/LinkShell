import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Only an entry point physically inside a complete app may claim app-managed updates. */
export function standaloneBundle(entry = process.argv[1] ?? ""): string | undefined {
  let path: string;
  try { path = realpathSync(entry); } catch { return undefined; }
  const marker = ".app/Contents/Resources/runtime/cli/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const app = path.slice(0, index + 4);
  return existsSync(join(app, "Contents/Resources/standalone.json")) && existsSync(join(app, "Contents/MacOS/node")) ? app : undefined;
}
