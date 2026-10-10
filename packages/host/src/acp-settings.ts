import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { acpAgentSettingsSchema, acpRemoteAgentSchema, type AcpAgentSettings, type AcpRemoteAgent } from "@linkshell/wire";

const schema = z.object({ settings: z.record(acpAgentSettingsSchema).default({}), agents: z.array(acpRemoteAgentSchema).default([]) });
export class AcpSettingsStore {
  constructor(private readonly path: string) {}
  private read(): z.infer<typeof schema> {
    try { return schema.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, agents: [] }; throw new Error("ACP 配置文件无效，请检查 acp.json", { cause: error }); }
  }
  settings(agent: string): AcpAgentSettings { const value = this.read(); return value.settings[agent] ?? value.agents.find((entry) => entry.id === agent)?.settings ?? acpAgentSettingsSchema.parse({}); }
  setSettings(agent: string, settings: AcpAgentSettings): void {
    const value = this.read(); value.settings[agent] = acpAgentSettingsSchema.parse(settings); this.write(value);
  }
  agents(): AcpRemoteAgent[] { return this.read().agents; }
  saveAgent(agent: AcpRemoteAgent): void {
    const value = this.read(); value.agents = [...value.agents.filter((entry) => entry.id !== agent.id), acpRemoteAgentSchema.parse(agent)]; this.write(value);
  }
  removeAgent(id: string): void { const value = this.read(); value.agents = value.agents.filter((agent) => agent.id !== id); delete value.settings[id]; this.write(value); }
  private write(value: z.infer<typeof schema>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
