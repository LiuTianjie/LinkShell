import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
export const binaries = { codex: join(directory, "node_modules/.bin/codex"), claude: join(directory, "node_modules/.bin/claude") };

export function verifyToolchain() {
  const host = JSON.parse(readFileSync(join(directory, "../../package.json"), "utf8"));
  const versions: Record<string, string> = {};
  for (const [agent, name] of [["codex", "@openai/codex"], ["claude", "@anthropic-ai/claude-code"]] as const) {
    const expected = manifest.dependencies[name];
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expected)) throw new Error(`${name} must use an exact version`);
    const installed = JSON.parse(readFileSync(join(directory, "node_modules", name, "package.json"), "utf8")).version;
    const actual = execFileSync(binaries[agent], ["--version"], { encoding: "utf8", timeout: 15_000 }).match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
    if (installed !== expected || actual !== expected) throw new Error(`${name}: expected ${expected}, package=${installed}, binary=${actual}`);
    versions[name] = expected;
  }
  for (const name of ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/sdk", "@anthropic-ai/claude-agent-sdk"]) {
    const expected = host.dependencies[name];
    if (!/^\d+\.\d+\.\d+$/.test(expected)) throw new Error(`${name} must use an exact version`);
    let path = dirname(require.resolve(name === "@agentclientprotocol/claude-agent-acp" ? `${name}/dist/index.js` : name));
    while (true) {
      try {
        const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
        if (pkg.name === name) { if (pkg.version !== expected) throw new Error(`${name}: expected ${expected}, got ${pkg.version}`); break; }
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      const parent = dirname(path); if (parent === path) throw new Error(`Could not resolve ${name}`); path = parent;
    }
    versions[name] = expected;
  }
  return versions;
}
