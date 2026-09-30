import { describe, expect, it } from "vitest";
import { createIdentity, publicIdentity } from "../src/crypto.js";
import { answerTunnel, openTunnel } from "../src/relay.js";

describe("tunnel handshake", () => {
  it("connects the two key holders", () => {
    const device = createIdentity();
    const machine = createIdentity();
    const opening = openTunnel(device, publicIdentity(machine), "ch1");
    if (opening.hello.k !== "hello") throw new Error();
    const { welcome, channel: machineSide } = answerTunnel(machine, publicIdentity(device), opening.hello);
    if (welcome.k !== "welcome") throw new Error();
    const deviceSide = opening.accept(welcome);
    expect(machineSide.open(deviceSide.seal("ping"))).toBe("ping");
    expect(deviceSide.open(machineSide.seal("pong"))).toBe("pong");
  });

  it("refuses an impostor on either side", () => {
    const device = createIdentity();
    const machine = createIdentity();
    const impostor = createIdentity();
    const opening = openTunnel(device, publicIdentity(machine), "ch1");
    if (opening.hello.k !== "hello") throw new Error();
    // The gateway (or anyone) claims the hello came from another device.
    expect(() => answerTunnel(machine, publicIdentity(impostor), opening.hello)).toThrow();
    // The hello is bound to the machine: an impostor can't answer it as itself…
    expect(() => answerTunnel(impostor, publicIdentity(device), opening.hello)).toThrow();
    // …nor forge the machine's welcome.
    const forged = openTunnel(impostor, publicIdentity(device), "ch1").hello;
    expect(() => opening.accept({ k: "welcome", ch: "ch1", eph: forged.k === "hello" ? forged.eph : "", sig: forged.k === "hello" ? forged.sig : "" })).toThrow();
  });
});
