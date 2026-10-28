import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseEnviron, parsePsEnvironment, processEnv, routingFrom } from "../src/drivers/claude/routing.js";
import { isDesktopApp } from "../src/drivers/claude/holders.js";

describe("routingFrom", () => {
  it("follows a holder handed another API, emptying what only the host has", () => {
    const routing = routingFrom(
      { ANTHROPIC_BASE_URL: "https://relay.example/api", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1", HTTPS_PROXY: "http://proxy:1", HOME: "/h", CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1" },
      { ANTHROPIC_API_KEY: "host-key", ANTHROPIC_MODEL: "opus", PATH: "/usr/bin" },
    );
    expect(routing).toEqual({
      ANTHROPIC_BASE_URL: "https://relay.example/api",
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      HTTPS_PROXY: "http://proxy:1",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
    });
  });

  it("keeps the host's own setup when the holder routes the same way", () => {
    const same = { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_AUTH_TOKEN: "t" };
    expect(routingFrom({ ...same, PATH: "/a" }, { ...same, PATH: "/b" })).toBeUndefined();
    // A proxy alone doesn't make another API.
    expect(routingFrom({ ...same, HTTPS_PROXY: "http://p:1" }, same)).toBeUndefined();
  });

  it("follows a holder that reads settings.json while the host was given an API", () => {
    // The holder has nothing routed: settings.json decides for it, so the host's values must go.
    expect(routingFrom({ HOME: "/h" }, { ANTHROPIC_BASE_URL: "https://elsewhere", ANTHROPIC_AUTH_TOKEN: "x" })).toEqual({ ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "" });
  });

  it("leaves a Claude account's token to the host's own Claude", () => {
    expect(routingFrom({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" }, {})).toBeUndefined();
  });
});

describe("reading another process's environment", () => {
  it("splits ps -E output, values with spaces and equals signs included", () => {
    const command = "/opt/claude --resume=abc --model x";
    const env = parsePsEnvironment(command, `${command} PATH=/usr/bin CREDS=/Users/me/Library/Application Support/x.json LIST=a=b,c=d EMPTY= LAST=z`);
    expect(env).toEqual({ PATH: "/usr/bin", CREDS: "/Users/me/Library/Application Support/x.json", LIST: "a=b,c=d", EMPTY: "", LAST: "z" });
  });

  it("gives nothing for a process whose environment the system hides", () => {
    expect(parsePsEnvironment("/bin/sleep 30", "/bin/sleep 30")).toBeUndefined();
    expect(parsePsEnvironment("/bin/sleep 30", "/other")).toBeUndefined();
  });

  it("splits /proc environ", () => {
    expect(parseEnviron("A=1\0B=two words\0C=x=y\0")).toEqual({ A: "1", B: "two words", C: "x=y" });
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("reads a running process's environment", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { env: { PATH: "/usr/bin", LS_ROUTE: "has space/inside", LS_OTHER: "x=y" }, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await processEnv(child.pid!)).toMatchObject({ LS_ROUTE: "has space/inside", LS_OTHER: "x=y" });
    } finally {
      child.kill();
    }
  });
});

describe("isDesktopApp", () => {
  it("counts the desktop app set up with another provider", () => {
    expect(isDesktopApp({ pid: 1, entrypoint: "claude-desktop" })).toBe(true);
    expect(isDesktopApp({ pid: 1, entrypoint: "claude-desktop-3p" })).toBe(true);
    expect(isDesktopApp({ pid: 1, entrypoint: "cli" })).toBe(false);
    expect(isDesktopApp({ pid: 1 })).toBe(false);
  });
});
