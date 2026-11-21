import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MethodResult, SessionConfigOption } from "@linkshell/wire";
import { probeAgent } from "../../process.js";
import type { SideOutput, SideRequest } from "../types.js";
import { AgySideRunner } from "./agy-side.js";
import { AcpDriver, type AcpAgentSpec, type AcpLaunchCandidate } from "./driver.js";

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

const AGY_DEFAULT_MODES: SessionConfigOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  current: "default",
  values: [
    { value: "default", name: "Default", description: "Ask before edits and commands, per your permission settings." },
    { value: "accept-edits", name: "Accept edits", description: "Approve file edits in the workspace without asking." },
    { value: "auto", name: "Auto", description: "Approve edits and safe commands; ask before irreversible actions." },
    { value: "plan", name: "Plan", description: "Plan carefully before executing a task." },
  ],
};

const EFFORT_ID_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/i;
const EFFORT_NAME_SUFFIX = /^(.+?)\s*\((low|medium|high|xhigh|max)\)$/i;
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface AgyModelCatalog {
  models: { value: string; name: string }[];
  defaultModel?: string;
  effortsByModel: Map<string, { defaultEffort: string; values: { value: string; name: string }[] }>;
}

/**
 * Parses `agy models` output into the same model + `thought_level` shape that
 * `agy acp` reports in `configOptions`, collapsing effort variants (e.g.
 * `gemini-4-neon-low|medium|high|xhigh`) into one base model entry.
 */
export function parseAgyModelsOutput(raw: string): AgyModelCatalog {
  const entries: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const segment of raw.replace(ANSI_ESCAPE, "").split(/[\r\n]+/)) {
    const line = segment.trim();
    if (!line || line.includes("Fetching available models")) continue;
    // Non-TTY `agy models` uses a single tab separator; TTY pads with 2+ spaces.
    const match = /^([a-z0-9][a-z0-9._-]+)(?:\t+|\s{2,})(.+)$/i.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const name = match[2]!.trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, name });
  }

  interface Grouped {
    baseId: string;
    baseName: string;
    variants: { id: string; name: string; effort?: string }[];
  }
  const order: Grouped[] = [];
  const byBase = new Map<string, Grouped>();

  for (const entry of entries) {
    const idMatch = EFFORT_ID_SUFFIX.exec(entry.id);
    const nameMatch = EFFORT_NAME_SUFFIX.exec(entry.name);
    const effort =
      idMatch && nameMatch && idMatch[2]!.toLowerCase() === nameMatch[2]!.toLowerCase()
        ? idMatch[2]!.toLowerCase()
        : undefined;
    const baseId = effort ? idMatch![1]! : entry.id;
    const baseName = effort ? nameMatch![1]!.trim() : entry.name;
    let group = byBase.get(baseId);
    if (!group) {
      group = { baseId, baseName, variants: [] };
      byBase.set(baseId, group);
      order.push(group);
    }
    group.variants.push({ id: entry.id, name: entry.name, effort });
  }

  const models: { value: string; name: string }[] = [];
  const effortsByModel = new Map<string, { defaultEffort: string; values: { value: string; name: string }[] }>();

  for (const group of order) {
    const efforts = group.variants.map((v) => v.effort).filter((e): e is string => Boolean(e));
    if (group.variants.length > 1 && efforts.length === group.variants.length) {
      models.push({ value: group.baseId, name: group.baseName });
      const uniqueEfforts = [...new Set(efforts)];
      const orderedEfforts = [
        ...EFFORT_ORDER.filter((level) => uniqueEfforts.includes(level)),
        ...uniqueEfforts.filter((level) => !(EFFORT_ORDER as readonly string[]).includes(level)),
      ];
      effortsByModel.set(group.baseId, {
        defaultEffort: efforts[0]!,
        values: orderedEfforts.map((value) => ({ value, name: EFFORT_LABELS[value] ?? value })),
      });
    } else {
      for (const variant of group.variants) {
        models.push({ value: variant.id, name: variant.name });
      }
    }
  }

  return {
    models,
    defaultModel: models[0]?.value,
    effortsByModel,
  };
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function agySpec(env: NodeJS.ProcessEnv = process.env): AcpAgentSpec {
  const explicit = env.LINKSHELL_AGY_PATH?.trim();
  const alternatives: AcpLaunchCandidate[] = [];
  if (explicit) {
    alternatives.push({ command: "agy", args: ["acp"] });
  } else if (process.platform !== "win32" && env.PATH !== "") {
    const home = env.HOME || homedir();
    const localBin = join(home, ".local", "bin", "agy");
    if (isExecutable(localBin)) {
      alternatives.push({ command: localBin, args: ["acp"] });
    }
  }
  return {
    id: "agy",
    label: "AGY",
    tier: "remote",
    command: explicit || "agy",
    args: ["acp"],
    ...(alternatives.length ? { alternatives } : {}),
    discover: true,
    // Deliberately omit authStatus: official OAuth, API keys and CC-Switch / custom providers
    // are all valid as long as `agy acp` itself serves sessions.
  };
}

const CLI_MODELS_CACHE_MS = 10 * 60_000;

/**
 * Antigravity CLI (`agy acp`) driver.
 * Kept separate from Antigravity Desktop (`antigravity`) so CLI sessions stay
 * independent, work without the desktop app open, and pass through whatever
 * credentials or CC-Switch configuration `agy` itself is configured with.
 */
export class AgyDriver extends AcpDriver {
  private cliModelsCache?: { at: number; catalog: AgyModelCatalog };
  private cliModelsInflight?: Promise<AgyModelCatalog | undefined>;
  private readonly sideRunner: AgySideRunner;

  constructor(options: { env?: NodeJS.ProcessEnv; hostVersion: string }) {
    super(agySpec(options.env ?? process.env), options);
    this.sideRunner = new AgySideRunner(
      () => this.agyCommand(),
      () => this.env,
      (message) => this.host?.log(message),
    );
  }

  protected override hasSide(): boolean {
    return true;
  }

  override async sideAsk(nativeId: string, request: SideRequest, out: SideOutput, signal: AbortSignal): Promise<void> {
    await this.sideRunner.ask(nativeId, request, out, signal);
  }

  async sideClose(nativeId: string, sideId: string): Promise<void> {
    await this.sideRunner.close(nativeId, sideId);
  }

  private agyCommand(): string {
    return this.resolvedLaunch?.command ?? this.spec.command;
  }

  private async loadCliModels(): Promise<AgyModelCatalog | undefined> {
    if (this.cliModelsCache && Date.now() - this.cliModelsCache.at < CLI_MODELS_CACHE_MS) {
      return this.cliModelsCache.catalog;
    }
    this.cliModelsInflight ??= (async () => {
      try {
        const { stdout, stderr } = await probeAgent(this.agyCommand(), ["models"], { env: this.env, timeout: 12_000 });
        const catalog = parseAgyModelsOutput(`${stdout}\n${stderr}`);
        if (catalog.models.length > 0) {
          this.cliModelsCache = { at: Date.now(), catalog };
          return catalog;
        }
      } catch {
        // Offline or custom provider setups may not implement `agy models`; live ACP still populates models.
      }
      return this.cliModelsCache?.catalog;
    })().finally(() => {
      this.cliModelsInflight = undefined;
    });
    return this.cliModelsInflight;
  }

  override async listModels(_cwd?: string, model?: string): Promise<MethodResult<"agents.models">> {
    const known = this.knownModels();
    const catalog = await this.loadCliModels();

    if (known?.models.length) {
      const selected = model && known.models.some((entry) => entry.value === model) ? model : known.current;
      const baseConfig = known.config ?? [];
      if (selected && catalog && catalog.models.some((entry) => entry.value === selected)) {
        const effortSpec = catalog.effortsByModel.get(selected);
        const existingEffort = baseConfig.find((entry) => entry.category === "effort");
        const withoutEffort = baseConfig.filter((entry) => entry.category !== "effort");
        const nextConfig: SessionConfigOption[] = effortSpec
          ? [
              ...withoutEffort,
              {
                id: existingEffort?.id ?? "thought_level",
                name: existingEffort?.name ?? "Thinking Level",
                category: "effort",
                current:
                  existingEffort && effortSpec.values.some((v) => v.value === existingEffort.current)
                    ? existingEffort.current
                    : effortSpec.defaultEffort,
                values: effortSpec.values,
              },
            ]
          : withoutEffort;
        return { ...known, ...(nextConfig.length ? { config: nextConfig } : { config: undefined }) };
      }
      return known;
    }

    if (catalog?.models.length) {
      const selected = model && catalog.models.some((entry) => entry.value === model) ? model : catalog.defaultModel;
      const effortSpec = selected ? catalog.effortsByModel.get(selected) : undefined;
      const config: SessionConfigOption[] = [
        ...(effortSpec
          ? [
              {
                id: "thought_level",
                name: "Thinking Level",
                category: "effort" as const,
                current: effortSpec.defaultEffort,
                values: effortSpec.values,
              },
            ]
          : []),
        AGY_DEFAULT_MODES,
      ];
      return {
        models: catalog.models,
        ...(catalog.defaultModel ? { current: catalog.defaultModel } : {}),
        config,
      };
    }

    return { models: [] };
  }

  /**
   * Accepts both base model IDs (`gemini-4-neon`) and combined IDs
   * (`gemini-4-neon-high`) when setting the model, splitting out `thought_level`
   * if the live session exposes them separately.
   */
  override async setConfig(nativeId: string, optionId: string, value: string): Promise<void> {
    const state = this.sessions.get(nativeId);
    const option = state?.config.find((entry) => entry.id === optionId);
    if (state && option?.category === "model" && !option.values.some((entry) => entry.value === value)) {
      const split = EFFORT_ID_SUFFIX.exec(value);
      if (split && option.values.some((entry) => entry.value === split[1])) {
        await super.setConfig(nativeId, optionId, split[1]!);
        const effortOption = this.sessions.get(nativeId)?.config.find((entry) => entry.category === "effort");
        const level = split[2]!.toLowerCase();
        if (effortOption && effortOption.values.some((entry) => entry.value === level)) {
          await super.setConfig(nativeId, effortOption.id, level);
        }
        return;
      }
    }
    await super.setConfig(nativeId, optionId, value);
  }

  /**
   * `agy acp`'s `session/list` includes desktop summaries whose local databases
   * live only under `~/.gemini/antigravity` (where `session/load` replays no
   * messages). Keep desktop-only sessions under `antigravity` to avoid duplicates.
   */
  override sessionExists(nativeId: string, _cwd: string): boolean {
    if (this.sideRunner.isHiddenSideSession(nativeId)) return false;
    if (this.sessions.has(nativeId)) return true;
    const home = this.env.HOME || homedir();
    const cliDir = join(home, ".gemini", "antigravity-cli");
    if (existsSync(join(cliDir, "conversations", `${nativeId}.db`)) || existsSync(join(cliDir, "brain", nativeId))) {
      return true;
    }
    const desktopDir = join(home, ".gemini", "antigravity");
    if (
      existsSync(join(desktopDir, "brain", nativeId)) ||
      existsSync(join(desktopDir, "conversations", `${nativeId}.pb`)) ||
      existsSync(join(desktopDir, "conversations", `${nativeId}.db`))
    ) {
      return false;
    }
    return true;
  }
}
