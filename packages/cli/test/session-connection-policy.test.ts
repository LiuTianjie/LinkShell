import { describe, expect, it } from "vitest";
import {
  connectionDetailForClose,
  reconnectDelayForAttempt,
  sessionErrorConnectionImpact,
  shouldReconnectAfterClose,
} from "../../../apps/mobile/src/hooks/session-connection-policy.js";

describe("mobile session connection policy", () => {
  it("keeps retrying websocket closes unless the user or session ended it", () => {
    expect(shouldReconnectAfterClose({
      code: 1006,
      manualDisconnect: false,
      status: "connected",
    })).toBe(true);
    expect(shouldReconnectAfterClose({
      code: 4001,
      manualDisconnect: false,
      status: "reconnecting",
    })).toBe(true);
    expect(shouldReconnectAfterClose({
      code: 4003,
      manualDisconnect: false,
      status: "connected",
    })).toBe(true);
    expect(shouldReconnectAfterClose({
      code: 1000,
      manualDisconnect: true,
      status: "connected",
    })).toBe(false);
    expect(shouldReconnectAfterClose({
      code: 1000,
      manualDisconnect: false,
      status: "session_exited",
    })).toBe(false);
  });

  it("uses unbounded retry attempts with a capped delay", () => {
    expect(reconnectDelayForAttempt(0)).toBe(1_000);
    expect(reconnectDelayForAttempt(1)).toBe(2_000);
    expect(reconnectDelayForAttempt(4)).toBe(15_000);
    expect(reconnectDelayForAttempt(100)).toBe(15_000);
  });

  it("does not treat ordinary session errors as connection-fatal", () => {
    expect(sessionErrorConnectionImpact("invalid_message")).toBe("none");
    expect(sessionErrorConnectionImpact("control_conflict")).toBe("none");
    expect(sessionErrorConnectionImpact("session_terminated")).toBe("session_exited");
    expect(sessionErrorConnectionImpact("subscription_expired")).toBe("subscription_expired");
  });

  it("surfaces auth-related close reasons without making them terminal", () => {
    expect(connectionDetailForClose(4001)).toContain("重试");
    expect(connectionDetailForClose(4003)).toContain("重试");
    expect(connectionDetailForClose(1006)).toContain("Reconnecting");
  });
});
