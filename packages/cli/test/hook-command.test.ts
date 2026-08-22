import { describe, expect, it } from "vitest";
import { buildLinkShellHookCommand, shouldWriteProjectHooksJson } from "../src/runtime/hook-command.js";

describe("buildLinkShellHookCommand", () => {
  const cmd = buildLinkShellHookCommand(57722, "lsh-test", 30);

  it("still targets the local hook server", () => {
    expect(cmd).toContain("http://127.0.0.1:57722/hook?m=lsh-test&lid=$LINKSHELL_ID");
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
