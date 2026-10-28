import { useEffect, useState } from "react";
import type { MethodResult } from "@linkshell/wire";
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
export function useAgentModels(agent: string, cwd: string, ready: boolean): (MethodResult<"agents.models"> & { unavailable?: boolean }) | undefined {
  const { store } = useConnection();
  // `unavailable`: the host couldn't say (an older one has no list to give).
  const [listed, setListed] = useState<{ agent: string; unavailable?: boolean } & MethodResult<"agents.models">>();
  useEffect(() => {
    if (!ready || !agent) return;
    let alive = true;
    void store.getState().agentModels(agent, cwd.trim() || undefined).then(
      (result) => { if (alive) setListed({ agent, ...result }); },
      () => { if (alive) setListed({ agent, models: [], unavailable: true }); },
    );
    return () => { alive = false; };
  }, [store, agent, cwd, ready]);
  // Another agent's list is never shown, even for a moment; the same agent's stays while another directory is asked about.
  return listed?.agent === agent ? listed : undefined;
}

/** A model picked for `agent`, as `sessions.create` should get it: only when it isn't what the agent would choose anyway. */
export function modelToCreate(listed: MethodResult<"agents.models"> | undefined, picked: string | undefined): string | undefined {
  if (!listed || !picked || picked === listed.current) return undefined;
  return listed.models.some((entry) => entry.value === picked) ? picked : undefined;
}
