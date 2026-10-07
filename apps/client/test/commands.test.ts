import { describe, expect, it } from "vitest";
import { commandDetail, commandQuery, matchCommands, normalizeCommandText, offeredCommands, parseCommand, sessionCommands, type Command } from "@/lib/commands";

const command = (name: string, description = ""): Command => ({ name, description });
const names = (commands: Command[]) => commands.map((entry) => entry.name);

// As Claude sends them: skills first, built-ins last.
const fromAgent = [command("deploy", "Deploy the app"), command("model"), command("review", "Review a pull request"), command("compact", ""), command("deploy", "a built-in of the same name")];

describe("the slash commands the phone offers", () => {
  it("puts common built-ins first without hiding capabilities already filtered by the agent", () => {
    expect(names(offeredCommands(fromAgent))).toEqual(["compact", "review", "deploy", "model"]);
  });

  it("keeps the first of two commands with one name", () => {
    expect(offeredCommands(fromAgent).find((entry) => entry.name === "deploy")?.description).toBe("Deploy the app");
  });

  it("describes a pinned command in Chinese unless the agent already does", () => {
    expect(commandDetail(command("compact", ""))).toBe("压缩上下文");
    expect(commandDetail(command("review", "Review a pull request"))).toBe("审查改动");
    expect(commandDetail(command("review", "审查这个仓库的改动"))).toBe("审查这个仓库的改动");
    expect(commandDetail(command("deploy", " Deploy the app "))).toBe("Deploy the app");
  });

  it("finds commands by the start of the name, then inside it, then in what they do", () => {
    const commands = [command("preview", "Open a preview"), command("review"), command("deploy", "ship after review"), command("init")];
    expect(names(matchCommands(commands, "/rev"))).toEqual(["review", "preview", "deploy"]);
    expect(names(matchCommands(commands, "  REV "))).toEqual(["review", "preview", "deploy"]);
    // The Chinese label of a pinned command is searched too.
    expect(names(matchCommands(commands, "审查"))).toEqual(["review"]);
    expect(names(matchCommands(commands, ""))).toEqual(["review", "init", "preview", "deploy"]);
    expect(matchCommands(commands, "nothing-like-it")).toEqual([]);
  });
});

describe("mobile command entry", () => {
  it("opens after whitespace and full-width punctuation, but closes for arguments and paths", () => {
    for (const text of ["/", "／", "  /", "\n／"]) expect(commandQuery(text)).toBe("");
    expect(commandQuery("  ／rev")).toBe("rev");
    for (const text of ["hello /", "/review ", "/etc/hosts", "/review this", ""]) expect(commandQuery(text)).toBeUndefined();
    expect(parseCommand(" ／goal 完成测试 ")).toEqual({ name: "goal", args: "完成测试" });
    expect(normalizeCommandText("／goal 检查／目录")).toBe("/goal 检查／目录");
  });

  it("offers useful local controls before the native list arrives", () => {
    for (const agent of ["codex", "claude"]) {
      expect(names(sessionCommands(agent, [], []))).toEqual(expect.arrayContaining(["help", "settings", "diff", "new", "rename"]));
      expect(names(sessionCommands(agent, [], []))).not.toContain("goal");
    }
  });

  it("keeps remote Claude commands and maps reported settings to controls without duplicates", () => {
    const native = ["mcp", "output-style", "config", "reload-skills", "goal", "model", "fork"].map((name) => command(name));
    const list = sessionCommands("claude", native, [{ id: "model", name: "Model", category: "model", current: "sonnet", values: [{ value: "sonnet", name: "Sonnet" }] }]);
    expect(names(list)).toEqual(expect.arrayContaining(names(native)));
    expect(list.filter((entry) => entry.name === "model")).toEqual([expect.objectContaining({ action: "settings", optionId: "model" })]);
    expect(list.find((entry) => entry.name === "fork")?.action).toBeUndefined();
    expect(list.find((entry) => entry.name === "goal")?.action).toBe("goal");
  });
});
