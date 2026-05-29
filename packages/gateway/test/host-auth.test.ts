import { describe, it, expect } from "vitest";
import { HostAuthManager } from "../src/host-auth.js";

describe("HostAuthManager", () => {
  it("verifies the token it issued for a session", () => {
    const m = new HostAuthManager();
    const token = m.issue("session-a");
    expect(m.has("session-a")).toBe(true);
    expect(m.verify("session-a", token)).toBe(true);
    m.destroy();
  });

  it("rejects a wrong token for a bound session (hijack attempt)", () => {
    const m = new HostAuthManager();
    m.issue("session-a");
    expect(m.verify("session-a", "not-the-token")).toBe(false);
    expect(m.verify("session-a", undefined)).toBe(false);
    m.destroy();
  });

  it("reports no binding for an unknown session and rejects verify", () => {
    const m = new HostAuthManager();
    expect(m.has("ghost")).toBe(false);
    expect(m.verify("ghost", "anything")).toBe(false);
    m.destroy();
  });

  it("issues distinct tokens per session", () => {
    const m = new HostAuthManager();
    const a = m.issue("session-a");
    const b = m.issue("session-b");
    expect(a).not.toEqual(b);
    expect(m.verify("session-a", b)).toBe(false);
    expect(m.verify("session-b", a)).toBe(false);
    m.destroy();
  });

  it("adopts a host token on first use when no binding exists (TOFU)", () => {
    const m = new HostAuthManager();
    expect(m.has("session-restarted")).toBe(false);
    m.adopt("session-restarted", "host-supplied-token");
    expect(m.has("session-restarted")).toBe(true);
    expect(m.verify("session-restarted", "host-supplied-token")).toBe(true);
    expect(m.verify("session-restarted", "other")).toBe(false);
    m.destroy();
  });
});
