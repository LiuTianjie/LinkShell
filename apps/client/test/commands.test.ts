import { describe, expect, it } from "vitest";
import { commandDetail, matchCommands, offeredCommands, type Command } from "@/lib/commands";

const command = (name: string, description = ""): Command => ({ name, description });
const names = (commands: Command[]) => commands.map((entry) => entry.name);

// As Claude sends them: skills first, built-ins last.
const fromAgent = [command("deploy", "Deploy the app"), command("model"), command("review", "Review a pull request"), command("compact", ""), command("deploy", "a built-in of the same name")];

describe("the slash commands the phone offers", () => {
  it("puts the common built-ins first and leaves out what only works at the computer", () => {
    expect(names(offeredCommands(fromAgent))).toEqual(["compact", "review", "deploy"]);
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
