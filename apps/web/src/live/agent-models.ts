import { useEffect, useState } from "react";
import type { MethodResult, SessionConfigOption } from "@linkshell/wire";
import { useConnection } from "./common";
import { valueName } from "./ComposerControls";

type AgentModel = MethodResult<"agents.models">["models"][number];

/** How a model reads in a picker: as the composer shows the agent's own names, under its heading when it has one. */
export function modelName(model: AgentModel): string {
  return model.group ? `${model.group} · ${valueName(model.name)}` : valueName(model.name);
}

/**
 * The models the agent would offer a new session in `cwd`, for as long as they are the ones on
 * the page. Undefined while asking, and nothing to choose (an empty list) when the agent can't
 * tell before a session exists or the computer is too old to be asked.
 */
export function useAgentModels(agent: string, cwd: string, ready: boolean, model?: string, revision = 0): (MethodResult<"agents.models"> & { error?: string }) | undefined {
  const { store } = useConnection();
  const key = JSON.stringify([agent, cwd.trim(), model, revision]);
  const [listed, setListed] = useState<{ key: string; store: typeof store; error?: string } & MethodResult<"agents.models">>();
  useEffect(() => {
    if (!ready || !agent) return;
    let alive = true;
    void store.getState().agentModels(agent, cwd.trim() || undefined, model).then(
      (result) => { if (alive) setListed({ key, store, ...result }); },
      (error: unknown) => { if (alive) setListed({ key, store, models: [], error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { alive = false; };
  }, [store, agent, cwd, ready, model, key]);
  // A directory can have different permission defaults; stale settings must never be submitted.
  return ready && listed?.key === key && listed.store === store ? listed : undefined;
}

export function creationOptions(config: SessionConfigOption[] | undefined, picked: Record<string, string>): SessionConfigOption[] {
  return (config ?? []).filter((option) => (option.category === "mode" || option.category === "effort") && option.values.length > 0).map((option) => ({
    ...option,
    current: option.values.some((value) => value.value === picked[option.id]) ? picked[option.id]! : option.current,
  }));
}

/** Explicit choices are pinned even when they match a cached default from another project. */
export function configToCreate(config: SessionConfigOption[] | undefined, picked: Record<string, string>): Record<string, string> | undefined {
  const entries = (config ?? []).filter((option) => picked[option.id] !== undefined && option.values.some((value) => value.value === picked[option.id]))
    .map((option) => [option.id, picked[option.id]!] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A deliberate choice is pinned even when ACP cached it as another project's default. */
export function modelToCreate(listed: MethodResult<"agents.models"> | undefined, picked: string | undefined): string | undefined {
  if (!listed || !picked) return undefined;
  return listed.models.some((entry) => entry.value === picked) ? picked : undefined;
}
