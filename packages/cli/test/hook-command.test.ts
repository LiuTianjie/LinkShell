import { describe, expect, it } from "vitest";
import {
  buildLinkShellHookCommand,
  isLinkShellHookEntry,
  rewriteBareLinkShellId,
  shouldWriteProjectHooksJson,
} from "../src/runtime/hook-command.js";

describe("buildLinkShellHookCommand", () => {
  const cmd = buildLinkShellHookCommand(57722, "lsh-test", 30);

  it("still targets the local hook server", () => {
    expect(cmd).toContain("http://127.0.0.1:57722/hook?m=lsh-test&lid=${LINKSHELL_ID:-}");
  });

  it("does not require LINKSHELL_ID so native Claude Code will still run the hook", () => {
    expect(cmd).toContain("lid=${LINKSHELL_ID:-}");
    expect(cmd).not.toMatch(/\$LINKSHELL_ID(?:[^:\-]|$)/);
  });

  it("fail-opens with {} when curl prints nothing or the word ok", () => {
    expect(cmd).toContain("printf '%s\\n' '{}'");
    expect(cmd).toContain("'{'*");
    expect(cmd).not.toMatch(/\|\| true$/);
  });

  it("does not run curl inside Cursor's coding agent", () => {
    expect(cmd).toContain("CURSOR_TRACE_ID");
    expect(cmd).toContain("CURSOR_PROJECT_DIR");
  });
});

describe("shouldWriteProjectHooksJson", () => {
  it("refuses to write hooks.json inside a Cursor project", () => {
    expect(shouldWriteProjectHooksJson("/proj", (p) => p.endsWith("/.cursor"))).toBe(false);
  });

  it("allows hooks.json when there is no .cursor directory", () => {
    expect(shouldWriteProjectHooksJson("/proj", () => false)).toBe(true);
  });
});

describe("isLinkShellHookEntry", () => {
  it("matches current marker + LINKSHELL_ID curl commands", () => {
    const entry = {
      type: "command",
      command: buildLinkShellHookCommand(57722, "lsh-abc", 5),
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

describe("rewriteBareLinkShellId", () => {
  it("turns lid=$LINKSHELL_ID into an optional expansion", () => {
    const src = 'POST "http://127.0.0.1:1/hook?m=lsh-x&lid=$LINKSHELL_ID"';
    expect(rewriteBareLinkShellId(src)).toContain("lid=${LINKSHELL_ID:-}");
    expect(rewriteBareLinkShellId(src)).not.toMatch(/lid=\$LINKSHELL_ID"/);
  });

  it("leaves ${LINKSHELL_ID:-} unchanged", () => {
    const src = 'lid=${LINKSHELL_ID:-}';
    expect(rewriteBareLinkShellId(src)).toBe(src);
  });
});
