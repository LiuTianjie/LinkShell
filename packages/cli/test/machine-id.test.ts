import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateMachineIdentity } from "../src/machine-id.js";

describe("machine identity", () => {
  it("persists a generated machineId across restarts", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "linkshell-machine-"));

    const first = loadOrCreateMachineIdentity(homeDir);
    const second = loadOrCreateMachineIdentity(homeDir);

    expect(second.machineId).toBe(first.machineId);
    expect(second.hostname).toBe(first.hostname);
    expect(second.createdAt).toBe(first.createdAt);

    const filePath = join(homeDir, ".linkshell", "machine.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as typeof first;
    expect(raw.machineId).toBe(first.machineId);
  });
});

