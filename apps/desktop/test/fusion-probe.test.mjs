import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fusionSlug, isFusionSlug, pickDirectFusionHost } from "../dist/main/fusion-probe.js";

function fakeSocket(behavior) {
  const emitter = new EventEmitter();
  emitter.destroyed = false;
  emitter.destroy = () => {
    emitter.destroyed = true;
  };
  behavior(emitter);
  return emitter;
}

test("pickDirectFusionHost resolves preferred first candidate immediately without waiting for slow tails", async () => {
  const started = Date.now();
  const winner = await pickDirectFusionHost(["192.168.1.10", "100.121.94.123", "10.0.0.8"], 47391, {
    timeoutMs: 500,
    graceMs: 80,
    connect: (host) =>
      fakeSocket((sock) => {
        if (host === "192.168.1.10") setTimeout(() => sock.emit("connect"), 5);
      }),
  });
  assert.equal(winner, "192.168.1.10");
  assert.ok(Date.now() - started < 120);
});

test("pickDirectFusionHost falls through dead blackholed primary IP to reachable Tailscale IP within graceMs", async () => {
  const started = Date.now();
  const winner = await pickDirectFusionHost(["192.168.99.9", "100.121.94.123", "172.16.0.4"], 47391, {
    timeoutMs: 600,
    graceMs: 40,
    connect: (host) =>
      fakeSocket((sock) => {
        if (host === "100.121.94.123") setTimeout(() => sock.emit("connect"), 8);
      }),
  });
  assert.equal(winner, "100.121.94.123");
  assert.ok(Date.now() - started < 180);
});

test("pickDirectFusionHost bounds multi-host unreachable probe to single parallel timeout", async () => {
  const started = Date.now();
  const winner = await pickDirectFusionHost(["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"], 47391, {
    timeoutMs: 90,
    graceMs: 25,
    connect: () => fakeSocket(() => {}),
  });
  assert.equal(winner, undefined);
  assert.ok(Date.now() - started < 250);
});

test("fusionSlug matches the Swift side's shared vector and never derives from a display name", () => {
  // Same vector as apps/mac/Tests/LinkShellTests/FusionWireTests.swift (`sharedVector`).
  assert.equal(fusionSlug("wss://gateway.example#machine-1"), "25b8b967c6e4");
  assert.notEqual(fusionSlug("a"), fusionSlug("b"));
  assert.ok(isFusionSlug(fusionSlug("anything")));
  assert.equal(isFusionSlug("../etc"), false);
  assert.equal(isFusionSlug("m4"), false);
});
