import { describe, expect, it } from "vitest";
import type { AgentConversation } from "./types";
import {
  buildProviderOrganization,
  conversationOrganization,
  workspaceLabel,
} from "./conversation-organization";

function conv(partial: Partial<AgentConversation> & Pick<AgentConversation, "id" | "provider" | "cwd">): AgentConversation {
  return {
    status: "idle",
    control: "owned",
    archived: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...partial,
  };
}

describe("conversationOrganization", () => {
  it("groups Codex multi-root sessions as one workspace, not a single folder", () => {
    const org = conversationOrganization(conv({
      id: "c1",
      provider: "codex",
      cwd: "/Users/me/tifenxia-fe",
      workspaceRoots: [
        "/Users/me/tifenxia-fe",
        "/Users/me/tifenxia-ota",
        "/Users/me/serverx",
        "/Users/me/.codex/visualizations/2026/09/13/abc",
      ],
    }));
    expect(org.kind).toBe("workspace");
    expect(org.label).toBe("tifenxia-fe + 2 个项目");
    expect(org.key).toContain("tifenxia-ota");
    expect(org.key).not.toContain("visualizations");
  });

  it("uses Claude group when present instead of mixing into a generic folder", () => {
    const org = conversationOrganization(conv({
      id: "c2",
      provider: "claude",
      cwd: "/Users/me/infra-stacks",
      group: "infra-stacks",
    }));
    expect(org.kind).toBe("group");
    expect(org.label).toBe("infra-stacks");
  });

  it("keeps Gemini (and other cwd agents) on a folder bucket", () => {
    const org = conversationOrganization(conv({
      id: "c3",
      provider: "gemini",
      cwd: "/Users/me/office-worker",
    }));
    expect(org.kind).toBe("folder");
    expect(org.label).toBe("office-worker");
  });
});

describe("buildProviderOrganization", () => {
  it("separates Codex workspace sessions from Claude project groups", () => {
    const tree = buildProviderOrganization([
      conv({
        id: "codex-1",
        provider: "codex",
        cwd: "/a/fe",
        lastActivityAt: 20,
        workspaceRoots: ["/a/fe", "/a/ota"],
      }),
      conv({
        id: "claude-1",
        provider: "claude",
        cwd: "/a/fe",
        group: "fe",
        lastActivityAt: 10,
      }),
    ]);
    expect(tree.map((p) => p.provider)).toEqual(["claude", "codex"]);
    expect(tree[0]?.buckets[0]?.kind).toBe("group");
    expect(tree[1]?.buckets[0]?.kind).toBe("workspace");
    expect(tree[1]?.buckets[0]?.conversations.map((c) => c.id)).toEqual(["codex-1"]);
  });
});

describe("workspaceLabel", () => {
  it("names two-root workspaces with both folders", () => {
    expect(workspaceLabel(["/a/fe", "/a/ota"])).toBe("fe + ota");
  });
});
