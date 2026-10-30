import { test } from "node:test";
import assert from "node:assert/strict";
import { macUpdatePreparation } from "../dist/main/mac-update-preparation.js";

test("Mac update waits for confirmed Host stop and coalesces repeated install clicks", async () => {
  const events = [];
  let stopped;
  const prepare = macUpdatePreparation({
    prepare: () => { events.push("prepare"); return new Promise((resolve) => { stopped = resolve; }); },
    recover: async () => { events.push("recover"); },
    resume: () => { events.push("resume"); },
    failed: (message) => { events.push(message); },
  });
  const first = prepare();
  assert.equal(prepare(), first);
  assert.deepEqual(events, ["prepare"]);
  stopped();
  await first;
  assert.deepEqual(events, ["prepare", "resume"]);
});

test("failed Host stop never resumes Sparkle, recovers partial work, and permits a successful retry", async () => {
  const events = [];
  let fail = true;
  const prepare = macUpdatePreparation({
    prepare: async () => { events.push("prepare"); if (fail) throw new Error("Host did not stop"); },
    recover: async () => { events.push("recover"); },
    resume: () => { events.push("resume"); },
    failed: (message) => { events.push(message); },
  });
  await prepare();
  assert.deepEqual(events.slice(0, 2), ["prepare", "recover"]);
  assert.match(events[2], /Host did not stop/);
  assert.match(events[2], /重试/);
  assert.equal(events.includes("resume"), false);
  fail = false;
  await prepare();
  assert.deepEqual(events.slice(3), ["prepare", "resume"]);
});

test("recovery failure remains visible and cannot release the waiting installer", async () => {
  let message;
  let resumed = false;
  const prepare = macUpdatePreparation({
    prepare: async () => { throw new Error("prepare timeout"); },
    recover: async () => { throw new Error("recovery timeout"); },
    resume: () => { resumed = true; },
    failed: (value) => { message = value; },
  });
  await prepare();
  assert.equal(resumed, false);
  assert.match(message, /prepare timeout/);
  assert.match(message, /服务恢复需要处理：recovery timeout/);
});
