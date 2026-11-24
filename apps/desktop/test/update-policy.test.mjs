import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_UPDATE_CHECK_COOLDOWN_MS, PERIODIC_UPDATE_CHECK_INTERVAL_MS, shouldAutoCheckUpdates } from "../dist/main/update-policy.js";

test("auto update checks run on launch and foreground after cooldown, and skip when disabled or busy", () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldAutoCheckUpdates({ enabled: true, standalone: true, busy: false, lastCheckAt: 0, now }), true);
  assert.equal(shouldAutoCheckUpdates({ enabled: false, standalone: true, busy: false, lastCheckAt: 0, now }), false);
  assert.equal(shouldAutoCheckUpdates({ enabled: true, standalone: false, busy: false, lastCheckAt: 0, now }), false);
  assert.equal(shouldAutoCheckUpdates({ enabled: true, standalone: true, busy: true, lastCheckAt: 0, now }), false);

  assert.equal(
    shouldAutoCheckUpdates({ enabled: true, standalone: true, busy: false, lastCheckAt: now - AUTO_UPDATE_CHECK_COOLDOWN_MS + 1, now }),
    false,
  );
  assert.equal(
    shouldAutoCheckUpdates({ enabled: true, standalone: true, busy: false, lastCheckAt: now - AUTO_UPDATE_CHECK_COOLDOWN_MS, now }),
    true,
  );
  assert.equal(
    shouldAutoCheckUpdates({
      enabled: true,
      standalone: true,
      busy: false,
      lastCheckAt: now - PERIODIC_UPDATE_CHECK_INTERVAL_MS + 1,
      now,
      cooldownMs: PERIODIC_UPDATE_CHECK_INTERVAL_MS,
    }),
    false,
  );
});
