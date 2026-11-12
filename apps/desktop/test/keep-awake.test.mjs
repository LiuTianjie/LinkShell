import { test } from "node:test";
import assert from "node:assert/strict";
import { KeepAwake, normalizeKeepAwakeMode } from "../dist/main/keep-awake.js";

test("a desktop wake hold is idempotent, allows display sleep and releases on disable", () => {
  const active = new Set();
  const starts = [];
  const stops = [];
  const blocker = {
    start(type) { starts.push(type); const id = starts.length; active.add(id); return id; },
    stop(id) { stops.push(id); active.delete(id); },
    isStarted(id) { return active.has(id); },
  };
  const awake = new KeepAwake(blocker);
  assert.equal(awake.mode, "smart");
  assert.equal(awake.active, false);

  awake.set(false);
  assert.equal(awake.mode, "off");
  awake.set(true);
  awake.set(true);
  assert.equal(awake.mode, "always");
  assert.deepEqual(starts, ["prevent-app-suspension"]);
  assert.equal(active.size, 1);

  awake.set(false);
  awake.set(false);
  assert.deepEqual(stops, [1]);
  assert.equal(active.size, 0);

  awake.set("smart");
  assert.equal(awake.mode, "smart");
  assert.equal(active.size, 0);

  awake.set("smart", true);
  assert.equal(active.size, 1);
  awake.set("smart", false);
  assert.equal(active.size, 0);

  awake.set("always");
  assert.equal(active.size, 1);
  active.clear();
  awake.set("always");
  assert.equal(active.size, 1);
  awake.set("off");
  assert.equal(active.size, 0);

  assert.equal(normalizeKeepAwakeMode(undefined), "smart");
  assert.equal(normalizeKeepAwakeMode(true), "always");
  assert.equal(normalizeKeepAwakeMode(false), "off");
  assert.equal(normalizeKeepAwakeMode("smart"), "smart");
});
