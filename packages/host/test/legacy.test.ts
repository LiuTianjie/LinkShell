import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeLegacyCopilotHooks } from "../src/legacy.js";

const hook = (url: string) =>
  JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: `curl -s -X POST "${url}" --data-binary @-`, timeoutSec: 5 }] } });

describe("removeLegacyCopilotHooks", () => {
  it("removes 1.x hook files and leaves everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-hooks-"));
    writeFileSync(join(dir, "linkshell.json"), hook("http://127.0.0.1:50453/hook"));
    writeFileSync(join(dir, "linkshell-lsh-mnsv0f7k-huk8.json"), hook("http://127.0.0.1:54148/hook?m=lsh-mnsv0f7k-huk8"));
    writeFileSync(join(dir, "codeisland.json"), hook("http://127.0.0.1:9999/hook"));
    writeFileSync(join(dir, "linkshell-mine.json"), hook("http://127.0.0.1:1/hook"));
    writeFileSync(join(dir, "linkshell-lsh-other.json"), JSON.stringify({ version: 1, hooks: {} }));
    const logs: string[] = [];
    expect(removeLegacyCopilotHooks(dir, (m) => logs.push(m))).toBe(2);
    expect(existsSync(join(dir, "linkshell.json"))).toBe(false);
    expect(existsSync(join(dir, "linkshell-lsh-mnsv0f7k-huk8.json"))).toBe(false);
    expect(existsSync(join(dir, "codeisland.json"))).toBe(true);
    expect(existsSync(join(dir, "linkshell-mine.json"))).toBe(true);
    expect(existsSync(join(dir, "linkshell-lsh-other.json"))).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it("is quiet when there is no hooks directory", () => {
    expect(removeLegacyCopilotHooks(join(tmpdir(), "no-such-dir-ls"), () => {})).toBe(0);
  });
});
