import type { MethodResult } from "@linkshell/wire";

export interface AgentSessionPreferences {
  model?: string;
  config?: Record<string, string>;
}

export interface SessionPreferences {
  agent?: string;
  agents: Record<string, AgentSessionPreferences>;
}

/** Choices belong to a computer and agent; model ids and permission modes differ between hosts. */
export function createSessionPreferences(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }) {
  const key = (machineId: string) => `linkshell.new-session.v1:${machineId}`;
  const read = (machineId: string | undefined): SessionPreferences => {
    if (!machineId) return { agents: {} };
    try {
      const raw: unknown = JSON.parse(storage.getItem(key(machineId)) ?? "null");
      if (!raw || typeof raw !== "object") return { agents: {} };
      const saved = raw as Record<string, unknown>;
      const agents: Record<string, AgentSessionPreferences> = {};
      if (saved.agents && typeof saved.agents === "object") {
        for (const [id, value] of Object.entries(saved.agents)) {
          if (!value || typeof value !== "object") continue;
          const item = value as Record<string, unknown>;
          const config = item.config && typeof item.config === "object"
            ? Object.fromEntries(Object.entries(item.config).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
            : undefined;
          Object.defineProperty(agents, id, { enumerable: true, configurable: true, writable: true, value: { model: typeof item.model === "string" ? item.model : undefined, config } });
        }
      }
      return { agent: typeof saved.agent === "string" ? saved.agent : undefined, agents };
    } catch {
      return { agents: {} };
    }
  };
  const remember = (machineId: string | undefined, agent: string, values: AgentSessionPreferences = {}) => {
    if (!machineId || !agent) return;
    const saved = read(machineId);
    const previous = saved.agents[agent];
    try {
      storage.setItem(key(machineId), JSON.stringify({
        agent,
        agents: { ...saved.agents, [agent]: { ...previous, ...values, config: { ...previous?.config, ...values.config } } },
      }));
    } catch {
      // A storage failure must not prevent starting or configuring a session.
    }
  };
  return { read, remember };
}

export type SessionPreferencesStore = ReturnType<typeof createSessionPreferences>;

/** Shortcut callers share the same capability checks as the new-session form. Explicit input wins. */
export async function resolveSessionPreferences(
  input: AgentSessionPreferences,
  saved: AgentSessionPreferences | undefined,
  list: (model?: string) => Promise<MethodResult<"agents.models">>,
): Promise<AgentSessionPreferences> {
  const rememberedModel = input.model === undefined ? saved?.model : undefined;
  const rememberedConfig = Object.entries(saved?.config ?? {}).filter(([id]) => input.config?.[id] === undefined);
  if (!rememberedModel && !rememberedConfig.length) return input;
  let available: MethodResult<"agents.models">;
  try {
    available = await list(input.model ?? rememberedModel);
  } catch {
    // Restoring a convenience must not block creation or apply choices we could not validate.
    return input;
  }
  const model = input.model ?? (available.models.some((entry) => entry.value === rememberedModel) ? rememberedModel : undefined);
  const config = {
    ...Object.fromEntries(rememberedConfig.filter(([id, value]) => available.config?.some((option) =>
      option.id === id && (option.category === "mode" || option.category === "effort") && option.values.some((entry) => entry.value === value)))),
    ...input.config,
  };
  return { model, config: Object.keys(config).length ? config : input.config };
}
