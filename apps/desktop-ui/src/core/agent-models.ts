import { useEffect, useState } from "react";
import type { ClientStore } from "@linkshell/client-core";
import type { MethodResult, SessionConfigOption } from "@linkshell/wire";

export type AgentModelItem = MethodResult<"agents.models">["models"][number];

const OPTION_VALUE_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

export function formatOptionValueName(name: string): string {
  return OPTION_VALUE_LABELS[name.trim().toLowerCase()] ?? name;
}

export function modelName(model: AgentModelItem): string {
  return model.group ? `${model.group} · ${formatOptionValueName(model.name)}` : formatOptionValueName(model.name);
}

/**
 * Fetches dynamic models and configuration options for `agent` in `cwd`.
 * Keyed by `(store, agent, cwd, model, revision)` so stale directory defaults never leak across projects.
 */
export function useAgentModels(
  store: ClientStore | undefined,
  agent: string,
  cwd: string,
  ready: boolean,
  model?: string,
  revision = 0,
): (MethodResult<"agents.models"> & { error?: string }) | undefined {
  const key = JSON.stringify([agent, cwd.trim(), model, revision]);
  const [listed, setListed] = useState<
    ({ key: string; store: ClientStore; error?: string } & MethodResult<"agents.models">) | undefined
  >();

  useEffect(() => {
    if (!store || !ready || !agent) return;
    let alive = true;
    void store
      .getState()
      .agentModels(agent, cwd.trim() || undefined, model)
      .then(
        (result) => {
          if (!alive) return;
          setListed({
            key,
            store,
            ...result,
            models: Array.isArray(result?.models) ? result.models : [],
          });
        },
        (error: unknown) => {
          if (!alive) return;
          setListed({
            key,
            store,
            models: [],
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    return () => {
      alive = false;
    };
  }, [store, agent, cwd, ready, model, key]);

  return store && ready && listed?.key === key && listed.store === store ? listed : undefined;
}

export function creationOptions(
  config: SessionConfigOption[] | undefined,
  picked: Record<string, string>,
): SessionConfigOption[] {
  return (config ?? [])
    .filter((option) => (option.category === "mode" || option.category === "effort") && option.values.length > 0)
    .map((option) => ({
      ...option,
      current: option.values.some((value) => value.value === picked[option.id])
        ? picked[option.id]!
        : option.current,
    }));
}

export function configToCreate(
  config: SessionConfigOption[] | undefined,
  picked: Record<string, string>,
): Record<string, string> | undefined {
  const entries = (config ?? [])
    .filter(
      (option) =>
        picked[option.id] !== undefined && option.values.some((value) => value.value === picked[option.id]),
    )
    .map((option) => [option.id, picked[option.id]!] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function modelToCreate(
  listed: MethodResult<"agents.models"> | undefined,
  picked: string | undefined,
): string | undefined {
  if (!listed || !picked || !Array.isArray(listed.models)) return undefined;
  return listed.models.some((entry) => entry.value === picked) ? picked : undefined;
}
