import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLinkShellHookEntry,
  sweepLinkShellHookConfigs,
  sweepLinkShellHookEntries,
} from "../src/runtime/hook-command.js";

describe("isLinkShellHookEntry", () => {
  it("matches current marker + LINKSHELL_ID curl commands", () => {
    const entry = {
      type: "command",
      command: 'curl -s -X POST "http://127.0.0.1:57722/hook?m=lsh-abc&lid=${LINKSHELL_ID:-}" --data-binary @-',
    };
    expect(isLinkShellHookEntry(entry)).toBe(true);
    expect(isLinkShellHookEntry(entry, "lsh-abc")).toBe(true);
  });

  it("matches legacy settings.local curl to 127.0.0.1:<port>/hook", () => {
    const entry = {
      type: "command",
      command: "curl -s -X POST http://127.0.0.1:61919/hook -H 'Content-Type: application/json' --data-binary @-",
    };
    expect(isLinkShellHookEntry(entry)).toBe(true);
  });

  it("does not match CodeIsland or permission-guard wrappers", () => {
    expect(isLinkShellHookEntry({
      type: "command",
      command: "~/.codeisland/codeisland-hook.sh",
    })).toBe(false);
    expect(isLinkShellHookEntry({
      type: "command",
      command: 'case "${LINKSHELL_ID:-}" in lsh-*) exit 0 ;; esac\n# LINKSHELL_PERMISSION_GUARD\n~/.codeisland/codeisland-hook.sh',
    })).toBe(false);
  });
});

describe("sweepLinkShellHookConfigs", () => {
  it("removes leftover LinkShell hook entries and leaves other hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-hook-sweep-"));
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: "~/.codeisland/codeisland-hook.sh", type: "command" }] },
          { hooks: [{ command: "curl -s -X POST http://127.0.0.1:61919/hook --data-binary @-", type: "command" }] },
        ],
      },
    }, null, 2));

    const swept = sweepLinkShellHookConfigs(home);
    expect(swept).toContain(settingsPath);

    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(JSON.stringify(after.hooks.PreToolUse[0])).toContain("codeisland");
    expect(JSON.stringify(after)).not.toContain("/hook");

    expect(sweepLinkShellHookConfigs(home)).toEqual([]);
    expect(sweepLinkShellHookEntries(settingsPath)).toBe(false);
  });
});
