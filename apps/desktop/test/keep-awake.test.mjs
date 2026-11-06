import { test } from "node:test";
import assert from "node:assert/strict";
import { KeepAwake } from "../dist/main/keep-awake.js";

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
  awake.set(false);
  awake.set(true);
  awake.set(true);
  assert.deepEqual(starts, ["prevent-app-suspension"]);
  assert.equal(active.size, 1);
  awake.set(false);
  awake.set(false);
  assert.deepEqual(stops, [1]);
  assert.equal(active.size, 0);
  awake.set(true);
  assert.equal(active.size, 1);
  active.clear();
  awake.set(true);
  assert.equal(active.size, 1);
  awake.set(false);
  assert.equal(active.size, 0);
});
