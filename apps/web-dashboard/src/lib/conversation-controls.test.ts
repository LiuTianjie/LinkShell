import { describe, expect, it } from "vitest";
import type { AgentCapabilitiesPayload } from "./types";
import {
  conversationControlFlags,
  conversationIsOwned,
  conversationWriteType,
  writableConversationFlags,
} from "./conversation-controls";

function caps(partial: Partial<AgentCapabilitiesPayload> & { providers?: AgentCapabilitiesPayload["providers"] }): AgentCapabilitiesPayload {
  return {
    enabled: true,
    workspaceProtocolVersion: 2,
    supportsSessionList: false,
    supportsSessionLoad: false,
    supportsImages: false,
    supportsAudio: false,
    supportsPermission: false,
    supportsPlan: false,
    supportsCancel: false,
    ...partial,
  };
}

describe("conversationControlFlags", () => {
  it("hides every control when nothing is advertised", () => {
    const flags = conversationControlFlags(caps({ enabled: true }));
    expect(flags).toEqual({
      cancel: false,
      list: false,
      permission: false,
      plan: false,
      fork: false,
      images: false,
      model: false,
      effort: false,
      permissionMode: false,
    });
    const writes = conversationWriteType(flags);
    expect(writes.cancel).toBe("");
    expect(writes.permission).toBe("");
    expect(writes.list).toBe("");
  });

  it("enables advertised per-provider features and names the matching v2 writes", () => {
    const flags = conversationControlFlags(caps({
      supportsCancel: false,
      supportsSessionList: false,
      providers: [{
        id: "claude",
        label: "Claude",
        enabled: true,
        supportsCancel: true,
        supportsPermission: true,
        supportsPlan: true,
        supportsImages: true,
        permissionModes: ["read_only", "workspace_write", "full_access"],
        features: {
          cancel: true,
          sessionList: true,
          sessionFork: true,
          setModel: true,
          reasoningEffort: true,
          permissions: true,
          plan: true,
          images: true,
        },
      }],
    }), "claude");
    expect(flags.cancel).toBe(true);
    expect(flags.list).toBe(true);
    expect(flags.permission).toBe(true);
    expect(flags.plan).toBe(true);
    expect(flags.fork).toBe(true);
    expect(flags.images).toBe(true);
    expect(flags.model).toBe(true);
    expect(flags.effort).toBe(true);
    expect(flags.permissionMode).toBe(true);
    const writes = conversationWriteType(flags);
    expect(writes.cancel).toBe("agent.v2.cancel");
    expect(writes.list).toBe("agent.v2.conversation.list");
    expect(writes.permission).toBe("agent.v2.permission.respond");
    expect(writes.fork).toBe("agent.v2.conversation.open");
    expect(writes.model).toBe("agent.v2.conversation.update");
  });

  it("does not enable fork/model from top-level flags or provider name", () => {
    const flags = conversationControlFlags(caps({
      enabled: true,
      supportsCancel: true,
      supportsSessionList: true,
      supportsPermission: true,
      supportsPlan: true,
      supportsImages: true,
      providers: [{
        id: "claude",
        label: "Claude",
        enabled: true,
        supportsCancel: true,
        supportsPermission: true,
        supportsPlan: true,
        supportsImages: true,
        features: {
          cancel: true,
          sessionList: true,
          permissions: true,
          plan: true,
          images: true,
        },
      }],
    }), "claude");
    expect(flags.cancel).toBe(true);
    expect(flags.fork).toBe(false);
    expect(flags.model).toBe(false);
    expect(flags.effort).toBe(false);
    expect(conversationWriteType(flags).fork).toBe("");
    expect(conversationWriteType(flags).model).toBe("");
  });

  it("treats attached conversations as read-only even when the provider is capable", () => {
    expect(conversationIsOwned({ control: "owned" })).toBe(true);
    expect(conversationIsOwned({ control: "attached" })).toBe(false);
    const capsFull = caps({
      supportsCancel: true,
      supportsPermission: true,
      providers: [{
        id: "codex",
        label: "Codex",
        enabled: true,
        supportsCancel: true,
        supportsPermission: true,
        features: { cancel: true, permissions: true, setModel: true },
      }],
    });
    const writable = writableConversationFlags(capsFull, { control: "attached", provider: "codex" });
    expect(writable.cancel).toBe(false);
    expect(writable.permission).toBe(false);
    expect(writable.model).toBe(false);
    expect(conversationWriteType(writable).cancel).toBe("");
    const owned = writableConversationFlags(capsFull, { control: "owned", provider: "codex" });
    expect(owned.cancel).toBe(true);
  });
});
