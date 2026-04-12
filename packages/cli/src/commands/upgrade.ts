import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../../../package.json") as { version: string };

function isBrewInstall(): boolean {
  try {
    const out = execSync("brew list linkshell 2>/dev/null", {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.length > 0;
  } catch {
    return false;
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://registry.npmjs.org/linkshell-cli/latest",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

export async function runUpgrade(): Promise<void> {
  const current = pkg.version;
  process.stderr.write(`\n  Current version: ${current}\n`);
  process.stderr.write("  Checking for updates...\n\n");

  const latest = await fetchLatestVersion();
  if (!latest) {
    process.stderr.write("  \x1b[31m✗\x1b[0m Could not reach npm registry.\n\n");
    process.exitCode = 1;
    return;
  }

  if (latest === current) {
    process.stderr.write(`  \x1b[32m✓\x1b[0m Already on the latest version (${current}).\n\n`);
    return;
  }

  process.stderr.write(`  New version available: ${current} → \x1b[32m${latest}\x1b[0m\n\n`);

  if (isBrewInstall()) {
    process.stderr.write("  Upgrading via Homebrew...\n");
    try {
      execSync("brew upgrade linkshell", { stdio: "inherit", timeout: 120_000 });
      process.stderr.write("\n  \x1b[32m✓\x1b[0m Upgraded successfully.\n\n");
    } catch {
      process.stderr.write("\n  \x1b[31m✗\x1b[0m Homebrew upgrade failed. Try manually:\n");
      process.stderr.write("    brew upgrade linkshell\n\n");
      process.exitCode = 1;
    }
  } else {
    process.stderr.write("  Upgrading via npm...\n");
    try {
      execSync("npm install -g linkshell-cli@latest", { stdio: "inherit", timeout: 120_000 });
      process.stderr.write("\n  \x1b[32m✓\x1b[0m Upgraded successfully.\n\n");
    } catch {
      process.stderr.write("\n  \x1b[31m✗\x1b[0m npm upgrade failed. Try manually:\n");
      process.stderr.write("    npm install -g linkshell-cli@latest\n\n");
      process.exitCode = 1;
    }
  }
}
