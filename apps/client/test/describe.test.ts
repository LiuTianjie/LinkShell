import type { PermissionOption } from "@linkshell/wire";
import { describe, expect, it } from "vitest";
import { activityText, commandOf, permissionChoices, plainPreview, sessionTitle, tidyCommand } from "@/lib/describe";

const option = (optionId: string, kind: PermissionOption["kind"], name = optionId): PermissionOption => ({ optionId, kind, name });

describe("what an agent asks permission for", () => {
  it("offers refusing first, then allowing, in Chinese", () => {
    const choices = permissionChoices([option("a", "allow_always"), option("b", "allow_once"), option("c", "reject_once")]);
    expect(choices.map((choice) => [choice.label, choice.role])).toEqual([
      ["拒绝", "reject"],
      ["允许", "allow"],
      ["总是允许", "always"],
    ]);
  });

  it("knows Codex's and Claude's own choices by their ids", () => {
    const choices = permissionChoices([option("acceptForSession", "allow_always"), option("accept", "allow_once"), option("cancel", "reject_once"), option("decline", "reject_once")]);
    expect(choices.map((choice) => choice.label)).toEqual(["拒绝", "允许", "本会话都允许", "拒绝并停止"]);
  });

  it("uses the agent's own names when two choices are of one kind", () => {
    const choices = permissionChoices([option("x", "allow_always", "Always allow npm"), option("y", "allow_always", "Always allow everything"), option("z", "reject_once")]);
    expect(choices.map((choice) => choice.label)).toEqual(["拒绝", "Always allow npm", "Always allow everything"]);
  });
});

describe("a command, as shown on the phone", () => {
  it("loses the shell wrapper and the environment set up in front of it", () => {
    expect(tidyCommand("export TZ=UTC; npm test")).toBe("npm test");
    expect(tidyCommand("CI=1 FORCE_COLOR=0 pnpm build")).toBe("pnpm build");
    expect(tidyCommand("git status")).toBe("git status");
    // Nothing left after tidying: the command as it was.
    expect(tidyCommand("FOO=1")).toBe("FOO=1");
  });

  it("is read from a tool call's input, whichever shape the agent uses", () => {
    expect(commandOf({ title: "", rawInput: { command: "npm test" } })).toBe("npm test");
    expect(commandOf({ title: "", rawInput: { command: ["bash", "-lc", "npm test"] } })).toBe("npm test");
    expect(commandOf({ title: "", rawInput: { cmd: ["git", "status"] } })).toBe("git status");
    expect(commandOf({ title: "", rawInput: undefined })).toBeUndefined();
  });
});

describe("one line about a session", () => {
  it("says what the agent is doing", () => {
    expect(activityText(undefined)).toBe("正在运行…");
    expect(activityText({ kind: "thinking" })).toBe("思考中…");
    expect(activityText({ kind: "responding" })).toBe("正在回复…");
    expect(activityText({ kind: "tool" })).toBe("正在使用工具…");
  });

  it("names a session that has no title yet", () => {
    expect(sessionTitle({ title: "  " })).toBe("新会话");
    expect(sessionTitle({ title: " 修复配对 " })).toBe("修复配对");
  });

  it("flattens Markdown into plain text for the list", () => {
    expect(plainPreview("## 结果\n\n**全部通过**，见 [报告](https://example.com/r) 和 `pnpm test`。")).toBe("结果 全部通过，见 报告 和 pnpm test。");
    expect(plainPreview("改了三处：\n- 一\n- 二")).toBe("改了三处： 一 二");
    // A preview that arrives already on one line still has its bullets in it.
    expect(plainPreview("包括： - 一 - 二")).toBe("包括：一 · 二");
    expect(plainPreview("```ts\nconst a = 1;\n```\n完成")).toBe("完成");
  });
});
