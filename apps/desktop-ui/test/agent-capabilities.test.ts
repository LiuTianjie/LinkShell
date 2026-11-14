// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AgentInfo } from "@linkshell/wire";
import { buildSessionCommands } from "../src/features/session/session-helpers";
import { selectedTimelineText } from "../src/features/session/SelectionActions";
import { agentHasSide, quoteMarkdown, sideCommandName } from "../src/features/inspector/side-chat-store";
import { sideThreadTitle, splitSideQuote } from "../src/features/inspector/SideChatTabPanel";

const agent = (id: string, side?: boolean) =>
  ({ id, label: id, tier: "remote", installed: true, capabilities: { side } }) as unknown as AgentInfo;

describe("agent-specific side conversations", () => {
  it("knows which agents have one and what each calls it", () => {
    const agents = [agent("codex", true), agent("claude", true), agent("gemini", false), agent("cursor")];
    expect(agentHasSide(agents, "codex")).toBe(true);
    expect(agentHasSide(agents, "claude")).toBe(true);
    expect(agentHasSide(agents, "gemini")).toBe(false);
    expect(agentHasSide(agents, "cursor")).toBe(false);
    expect(agentHasSide(agents, undefined)).toBe(false);
    expect(sideCommandName("codex")).toBe("side");
    expect(sideCommandName("claude")).toBe("btw");
    expect(sideCommandName("grok")).toBe("btw");
  });

  it("lists the side command only for an agent that has one, ahead of the agent's own copy", () => {
    const advertised = [{ name: "btw", description: "agent's own" }, { name: "deploy", description: "a skill" }];
    const withSide = buildSessionCommands("claude", advertised, undefined, { sideCommand: "btw" });
    const btw = withSide.filter((command) => command.name === "btw");
    expect(btw).toHaveLength(1);
    expect(btw[0]!.source).toBe("local");
    expect(withSide.some((command) => command.name === "deploy")).toBe(true);

    const without = buildSessionCommands("gemini", [], undefined, {});
    expect(without.some((command) => command.name === "btw" || command.name === "side")).toBe(false);
    // Claude's and Codex's built-ins belong to them only.
    expect(without.some((command) => command.name === "init")).toBe(false);
    expect(buildSessionCommands("claude").some((command) => command.name === "init")).toBe(true);
  });
});

describe("quoting a selection", () => {
  it("quotes every line and keeps paragraph breaks", () => {
    expect(quoteMarkdown("  first line\r\nsecond\n\nthird  ")).toBe("> first line\n> second\n>\n> third");
    expect(quoteMarkdown("   ")).toBe("");
  });

  it("splits a side question into the passage and what was asked about it", () => {
    const text = `${quoteMarkdown("长段落\n第二行")}\n\n这段话想表达什么？`;
    expect(splitSideQuote(text)).toEqual({ quote: "长段落\n第二行", question: "这段话想表达什么？" });
    expect(sideThreadTitle(text, 24)).toBe("这段话想表达什么？");
    expect(sideThreadTitle(quoteMarkdown("only the passage"), 24)).toBe("only the passage");
    expect(sideThreadTitle("a question that is far too long to fit", 10)).toBe("a questio…");
  });

  it("takes a selection inside the timeline, not one in an answer box or elsewhere", () => {
    document.body.innerHTML = `
      <div id="track"><p id="msg">The agent said something worth asking about.</p><textarea id="answer">typed</textarea></div>
      <p id="outside">Elsewhere</p>`;
    const track = document.getElementById("track")!;
    const select = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection;
    };
    expect(selectedTimelineText(select(document.getElementById("msg")!), track)?.text).toBe(
      "The agent said something worth asking about.",
    );
    expect(selectedTimelineText(select(document.getElementById("outside")!), track)).toBeUndefined();
    expect(selectedTimelineText(select(document.getElementById("answer")!), track)).toBeUndefined();
    window.getSelection()!.removeAllRanges();
    expect(selectedTimelineText(window.getSelection(), track)).toBeUndefined();
  });
});
