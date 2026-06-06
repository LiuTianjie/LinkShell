import type { AgentCapabilities, AgentConversationRecord, AgentPermissionMode, AgentReasoningEffort } from "../types";
import { EFFORT_OPTIONS, PERMISSION_OPTIONS, type Option } from "./format";

export type { Option } from "./format";

export function providerCapabilityFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
) {
  return capabilities?.providers?.find((p) => p.id === provider);
}

export function modelOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<string>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  const dynamicModels = providerCapability?.models;
  const defaultModel = providerCapability?.defaultModel ?? "default";
  if (dynamicModels?.length) {
    return dynamicModels.map((m) => ({
      label: m.label,
      value: m.id === defaultModel || m.id === "default" ? undefined : m.id,
    }));
  }
  return [{ label: "默认模型", value: undefined }];
}

export function effortOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<AgentReasoningEffort>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  if (providerCapability?.reasoningEfforts) {
    if (providerCapability.reasoningEfforts.length === 0) return [];
    return [
      { label: "默认强度", value: undefined },
      ...EFFORT_OPTIONS.filter((option) =>
        option.value ? providerCapability.reasoningEfforts?.includes(option.value) : false,
      ),
    ];
  }
  return [];
}

export function permissionOptionsFor(
  provider: AgentConversationRecord["provider"],
  capabilities: AgentCapabilities | undefined,
): Option<AgentPermissionMode>[] {
  const providerCapability = providerCapabilityFor(provider, capabilities);
  if (providerCapability?.permissionModes) {
    if (providerCapability.permissionModes.length === 0) return [];
    return [
      { label: "默认权限", value: undefined, image: "hand.raised.fill" },
      ...PERMISSION_OPTIONS.filter((option) =>
        option.value ? providerCapability.permissionModes?.includes(option.value) : false,
      ),
    ];
  }
  return PERMISSION_OPTIONS;
}
