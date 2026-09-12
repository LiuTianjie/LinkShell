import type { AgentCapabilitiesPayload, AgentProviderCapability } from "./types";

/** UI/send flags derived only from `agent.v2.capabilities` advertisements. */
export interface ConversationControlFlags {
  cancel: boolean;
  list: boolean;
  permission: boolean;
  plan: boolean;
  fork: boolean;
  images: boolean;
  model: boolean;
  effort: boolean;
  permissionMode: boolean;
}

const OFF: ConversationControlFlags = {
  cancel: false,
  list: false,
  permission: false,
  plan: false,
  fork: false,
  images: false,
  model: false,
  effort: false,
  permissionMode: false,
};

function providerCapability(
  capabilities: AgentCapabilitiesPayload | null | undefined,
  providerId?: string,
): AgentProviderCapability | undefined {
  if (!capabilities?.providers?.length) return undefined;
  if (providerId) {
    const match = capabilities.providers.find((provider) => provider.id === providerId);
    if (match) return match;
  }
  return capabilities.providers.find((provider) => provider.enabled) ?? capabilities.providers[0];
}

function feature(cap: AgentProviderCapability | undefined, name: string): boolean | undefined {
  const value = cap?.features?.[name];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Map host `agent.v2.capabilities` onto conversation-console controls.
 * Unadvertised flags stay false — the UI must not send the matching write.
 */
export function conversationControlFlags(
  capabilities: AgentCapabilitiesPayload | null | undefined,
  providerId?: string,
): ConversationControlFlags {
  if (!capabilities) return { ...OFF };
  const cap = providerCapability(capabilities, providerId);
  const permission = cap?.supportsPermission
    ?? feature(cap, "permissions")
    ?? capabilities.supportsPermission
    ?? false;
  return {
    cancel: cap?.supportsCancel ?? feature(cap, "cancel") ?? capabilities.supportsCancel ?? false,
    list: feature(cap, "sessionList") ?? capabilities.supportsSessionList ?? false,
    permission,
    plan: cap?.supportsPlan ?? feature(cap, "plan") ?? capabilities.supportsPlan ?? false,
    fork: feature(cap, "sessionFork") ?? false,
    images: cap?.supportsImages ?? feature(cap, "images") ?? capabilities.supportsImages ?? false,
    model: feature(cap, "setModel") ?? false,
    effort: feature(cap, "reasoningEffort") ?? false,
    permissionMode: permission && (cap?.permissionModes?.length ?? 0) > 0,
  };
}

export function conversationWriteType(
  flags: ConversationControlFlags,
): Record<string, string> {
  return {
    cancel: flags.cancel ? "agent.v2.cancel" : "",
    list: flags.list ? "agent.v2.conversation.list" : "",
    permission: flags.permission ? "agent.v2.permission.respond" : "",
    fork: flags.fork ? "agent.v2.conversation.open" : "",
    images: flags.images ? "agent.v2.prompt" : "",
    model: flags.model ? "agent.v2.conversation.update" : "",
    effort: flags.effort ? "agent.v2.conversation.update" : "",
    permissionMode: flags.permissionMode ? "agent.v2.conversation.update" : "",
    plan: flags.plan ? "agent.v2.conversation.update" : "",
  };
}
