import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpDriver, type AcpAgentSpec } from "../src/drivers/acp/driver.js";
import { ACP_AGENTS, remoteDriver } from "../src/drivers/registry.js";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
chmodSync(FAKE_ACP, 0o755);

const CHINESE_AGENT_IDS = [
  "qwen",
  "kimi",
  "codebuddy",
  "qoder",
  "minimax",
  "trae",
  "deepseek",
  "glm",
  "iflow",
  "comate",
] as const;

const running: { host: RunningHost; home: string }[] = [];

afterEach(async () => {
  while (running.length) {
    const entry = running.pop()!;
    await entry.host.stop();
    rmSync(entry.home, { recursive: true, force: true });
  }
});

describe("mainstream Chinese ACP agents registry", () => {
  it("registers all mainstream Chinese coding agents with their verified ACP launch specs", () => {
    const byId = new Map(ACP_AGENTS.map((spec) => [spec.id, spec]));
    for (const id of CHINESE_AGENT_IDS) {
      expect(byId.has(id), `missing built-in agent: ${id}`).toBe(true);
    }

    expect(byId.get("qwen")).toMatchObject({ command: "qwen", args: ["--acp"] });
    expect(byId.get("kimi")).toMatchObject({ command: "kimi", args: ["acp"] });
    expect(byId.get("codebuddy")).toMatchObject({
      command: "codebuddy",
      args: ["--acp"],
      alternatives: [{ command: "codebuddy-code", args: ["--acp"] }],
    });
    expect(byId.get("cline")).toMatchObject({ command: "cline", args: ["--acp"] });
    expect(byId.get("kilo")).toMatchObject({ command: "kilo", args: ["acp"] });
    expect(byId.get("qoder")).toMatchObject({
      command: "qodercli",
      args: ["--acp"],
      alternatives: [
        { command: "qoder", args: ["--acp"] },
        { command: "qoder", args: ["acp"] },
      ],
    });
    expect(byId.get("minimax")).toMatchObject({
      command: "mcode",
      args: ["acp"],
      alternatives: [{ command: "code-acp", args: ["acp"] }],
    });
    expect(byId.get("trae")).toMatchObject({
      command: "traecli",
      args: ["acp", "serve"],
      alternatives: [{ command: "trae-cli", args: ["acp", "serve"] }],
    });
    expect(byId.get("deepseek")).toMatchObject({ command: "dsh", args: ["--profile", "acp"] });
    // glm-acp-agent does not handle --version and blocks on stdio unless given --help.
    expect(byId.get("glm")).toMatchObject({
      command: "glm-acp-agent",
      args: [],
      version: { command: "glm-acp-agent", args: ["--help"] },
    });
    expect(byId.get("iflow")).toMatchObject({ command: "iflow", args: ["--experimental-acp"] });
    expect(byId.get("comate")).toMatchObject({ command: "comate-acp", args: [] });
  });

  it("prevents custom ACP agents from shadowing built-in Chinese agent IDs", () => {
    for (const id of CHINESE_AGENT_IDS) {
      expect(() =>
        remoteDriver({ id, label: id, transport: "stdio", command: "echo", args: [] }, { hostVersion: "test" }),
      ).toThrow("自定义 Agent ID 不能覆盖内置 AI");
    }
  });

  it("falls back to alternative launch binaries when the primary command is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-cn-acp-"));
    const spec: AcpAgentSpec = {
      id: "minimax",
      label: "MiniMax Code",
      tier: "remote",
      command: "definitely-not-installed-mcode-binary",
      args: ["acp"],
      alternatives: [
        {
          command: FAKE_ACP,
          args: [],
          version: { command: FAKE_ACP, args: ["--version"] },
        },
      ],
    };
    const host = await startHost({
      home,
      version: "test",
      drivers: () => [new AcpDriver(spec, { env: { ...process.env, FAKE_ACP_STORE: join(home, "store.json") }, hostVersion: "test" })],
      log: () => {},
    });
    running.push({ host, home });

    const client = await connectHost(host.paths.hostSocket);
    try {
      const { agents } = await client.call("machine.info", {});
      const minimax = agents.find((entry) => entry.id === "minimax");
      expect(minimax?.installed).toBe(true);
      expect(minimax?.version).toBeTruthy();

      const { session } = await client.call("sessions.create", { agent: "minimax", cwd: home });
      expect(session.agent).toBe("minimax");
    } finally {
      client.close();
    }
  });

  it("reports the resolved alternative command when an agent requires login", async () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-cn-auth-"));
    const spec: AcpAgentSpec = {
      id: "qoder",
      label: "Qoder",
      tier: "remote",
      command: "definitely-not-installed-qodercli-binary",
      args: ["--acp"],
      alternatives: [
        {
          command: FAKE_ACP,
          args: [],
          version: { command: FAKE_ACP, args: ["--version"] },
        },
      ],
    };
    const host = await startHost({
      home,
      version: "test",
      drivers: () => [
        new AcpDriver(spec, {
          env: { ...process.env, FAKE_ACP_STORE: join(home, "store.json"), FAKE_ACP_SIGNED_OUT: "1" },
          hostVersion: "test",
        }),
      ],
      log: () => {},
    });
    running.push({ host, home });

    const client = await connectHost(host.paths.hostSocket);
    try {
      await expect(client.call("sessions.create", { agent: "qoder", cwd: home })).rejects.toThrow(FAKE_ACP);
    } finally {
      client.close();
    }
  });
});
