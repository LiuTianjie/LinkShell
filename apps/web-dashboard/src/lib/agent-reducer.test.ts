import { describe, expect, it } from "vitest";
import { adoptHostCatalog, mergeConversations } from "./agent-reducer";
import type { AgentConversation } from "./types";

function conv(partial: Partial<AgentConversation> & Pick<AgentConversation, "id">): AgentConversation {
  return {
    provider: "codex",
    cwd: "/tmp",
    status: "idle",
    control: "owned",
    archived: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...partial,
  };
}

describe("adoptHostCatalog", () => {
  it("drops cached conversations the host no longer lists", () => {
    const existing = [
      conv({ id: "old-1", lastActivityAt: 10 }),
      conv({ id: "keep-active", lastActivityAt: 9 }),
      conv({ id: "fresh", lastActivityAt: 8 }),
    ];
    const incoming = [
      conv({ id: "fresh", lastActivityAt: 20, title: "Fresh" }),
    ];
    const next = adoptHostCatalog(existing, incoming, ["keep-active"]);
    expect(next.map((c) => c.id).sort()).toEqual(["fresh", "keep-active"]);
    expect(next.find((c) => c.id === "fresh")?.title).toBe("Fresh");
  });

  it("still merges host fields onto retained rows", () => {
    const existing = [conv({ id: "a", title: "old", lastActivityAt: 1 })];
    const incoming = [conv({ id: "a", title: "new", status: "running", lastActivityAt: 2 })];
    const next = mergeConversations(existing, incoming);
    expect(next[0]?.title).toBe("new");
    expect(next[0]?.status).toBe("running");
  });
});
