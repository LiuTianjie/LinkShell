import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

it("loads the installed native module when doctor runs outside a Node project", () => {
  const cwd = mkdtempSync(join(tmpdir(), "linkshell doctor cwd "));
  const doctorUrl = new URL("../src/commands/doctor.ts", import.meta.url).href;
  const loader = createRequire(import.meta.url).resolve("tsx");

  try {
    const output = execFileSync(process.execPath, [
      "--import", loader,
      "--input-type=module",
      "--eval",
      `const { runDoctor } = await import(${JSON.stringify(doctorUrl)}); ` +
        // Explicit local invalid port avoids contacting any saved user gateway.
        `await runDoctor("http://127.0.0.1:1/ws");`,
    ], { cwd, encoding: "utf8", timeout: 15_000 });

    expect(output).toContain("node-pty: loaded");
    expect(output).not.toContain("native module not built");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
