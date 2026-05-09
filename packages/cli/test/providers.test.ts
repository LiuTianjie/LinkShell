import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderConfig } from "../src/providers.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

function makeExecutableInSpacedDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "linkshell spaced path "));
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(file, 0o755);
  return file;
}

function prependExecutableToPath(name: string): string {
  const executable = makeExecutableInSpacedDir(name);
  process.env.PATH = `${dirname(executable)}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`;
  return executable;
}

describe("resolveProviderConfig", () => {
  it("resolves an explicit executable path that contains spaces", () => {
    const executable = makeExecutableInSpacedDir("agent-cli");

    const config = resolveProviderConfig({
      provider: "custom",
      command: executable,
      args: ["--flag"],
    });

    expect(config.command).toBe(executable);
    expect(config.args).toEqual(["--flag"]);
  });

  it("strips outer quotes around executable paths with spaces", () => {
    const executable = makeExecutableInSpacedDir("agent-cli");

    const config = resolveProviderConfig({
      provider: "custom",
      command: `"${executable}"`,
      args: [],
    });

    expect(config.command).toBe(executable);
  });

  it("finds executables in PATH entries that contain spaces", () => {
    const executable = makeExecutableInSpacedDir("agent-cli");
    process.env.PATH = `${dirname(executable)}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`;

    const config = resolveProviderConfig({
      provider: "custom",
      command: "agent-cli",
      args: [],
    });

    expect(config.command).toBe(executable);
  });

  it("resolves Gemini as a first-class terminal provider", () => {
    const executable = prependExecutableToPath("gemini");

    const config = resolveProviderConfig({
      provider: "gemini",
      args: ["--model", "flash"],
    });

    expect(config.provider).toBe("gemini");
    expect(config.command).toBe(executable);
    expect(config.args).toEqual(["--model", "flash"]);
  });

  it("resolves GitHub Copilot as a first-class terminal provider", () => {
    const executable = prependExecutableToPath("github-copilot");

    const config = resolveProviderConfig({
      provider: "copilot",
      args: ["suggest"],
    });

    expect(config.provider).toBe("copilot");
    expect(config.command).toBe(executable);
    expect(config.args).toEqual(["suggest"]);
  });
});
