import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_SESSION_PAUSE_TIMEOUT_MS, SCREEN_SESSION_RETAIN_MS, ScreenSessionLease, ScreenSessionPauseWatchdog } from "../src/lib/screen-session-lease";

describe("mobile screen pause watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("times out exactly after two seconds and reports the waiting generation once", () => {
    const timeout = vi.fn();
    const watchdog = new ScreenSessionPauseWatchdog(timeout);
    expect(SCREEN_SESSION_PAUSE_TIMEOUT_MS).toBe(2_000);
    watchdog.wait(4);
    vi.advanceTimersByTime(1_999);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(4);
    vi.runAllTimers();
    watchdog.clear();
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it("cancels the timeout when the same generation acknowledges its pause", () => {
    const timeout = vi.fn();
    const watchdog = new ScreenSessionPauseWatchdog(timeout);
    watchdog.wait(4);
    vi.advanceTimersByTime(1_999);
    watchdog.acknowledge(4);
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(timeout).not.toHaveBeenCalled();
  });

  it("ignores acknowledgements from another generation", () => {
    const timeout = vi.fn();
    const watchdog = new ScreenSessionPauseWatchdog(timeout);
    watchdog.wait(4);
    watchdog.acknowledge(3);
    watchdog.acknowledge(5);
    vi.advanceTimersByTime(2_000);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("ignores canceled callbacks even after rearming the same generation", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const timeout = vi.fn();
    const watchdog = new ScreenSessionPauseWatchdog(timeout);
    watchdog.wait(4);
    const staleCallback = timer.mock.calls[0][0] as () => void;
    vi.advanceTimersByTime(1_000);
    watchdog.clear();
    watchdog.wait(4);
    staleCallback();
    vi.advanceTimersByTime(1_999);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("replaces an earlier wait and clears it without firing", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const timeout = vi.fn();
    const watchdog = new ScreenSessionPauseWatchdog(timeout);
    watchdog.wait(4);
    const staleCallback = timer.mock.calls[0][0] as () => void;
    watchdog.wait(5);
    const canceledCallback = timer.mock.calls[1][0] as () => void;
    expect(vi.getTimerCount()).toBe(1);
    staleCallback();
    watchdog.acknowledge(4);
    expect(vi.getTimerCount()).toBe(1);
    watchdog.clear();
    canceledCallback();
    vi.runAllTimers();
    expect(timeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("mobile screen session lease", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(reusable = true) {
    const dispose = vi.fn();
    const notify = vi.fn();
    const lease = new ScreenSessionLease<object>(dispose, notify);
    const owner = {};
    const resource = {};
    lease.activate(owner);
    lease.install(0, resource);
    if (reusable) lease.setReusable(0, true);
    return { dispose, notify, lease, owner, resource };
  }

  it("keeps the same resource while away and resumes it on return", () => {
    const { lease, owner, resource, dispose } = setup();
    lease.deactivate(owner);
    expect(lease.getSnapshot()).toEqual({ generation: 0, active: false, resource, reusable: true });
    expect(lease.getSnapshot().resource).toBe(resource);

    vi.advanceTimersByTime(SCREEN_SESSION_RETAIN_MS - 1);
    lease.activate({});
    expect(lease.getSnapshot()).toEqual({ generation: 0, active: true, resource, reusable: true });
    expect(lease.getSnapshot().resource).toBe(resource);
    vi.advanceTimersByTime(SCREEN_SESSION_RETAIN_MS);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("expires at 120 seconds and disposes the retained resource exactly once", () => {
    const { lease, owner, resource, dispose } = setup();
    expect(SCREEN_SESSION_RETAIN_MS).toBe(120_000);
    lease.deactivate(owner);
    vi.advanceTimersByTime(119_999);
    expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: false, resource: null, reusable: false });
    lease.dispose();
    vi.runAllTimers();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("discards a hidden screen socket that closes while the host connection stays online", () => {
    const { lease, owner, resource, dispose } = setup();
    lease.deactivate(owner);
    expect(lease.close(0)).toBe(false);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: false, resource: null, reusable: false });
    expect(vi.getTimerCount()).toBe(0);

    lease.activate(owner);
    const reconnected = {};
    expect(lease.install(1, reconnected)).toBe(true);
    expect(lease.getSnapshot().resource).toBe(reconnected);
    vi.advanceTimersByTime(SCREEN_SESSION_RETAIN_MS);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports an active socket close for retry UI without letting late closes discard the next viewer", () => {
    const { lease, resource, dispose } = setup();
    expect(lease.close(0)).toBe(true);
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: true, resource: null, reusable: false });
    const replacement = {};
    lease.install(1, replacement);
    expect(lease.close(0)).toBeNull();
    expect(lease.getSnapshot().resource).toBe(replacement);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
  });

  it("destroys a connection immediately when the host never advertises retention", () => {
    const { lease, owner, resource, dispose } = setup(false);
    lease.deactivate(owner);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: false, resource: null, reusable: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys an unsupported connection immediately even after an earlier capability was revoked", () => {
    const { lease, owner, resource, dispose } = setup();
    lease.setReusable(0, false);
    lease.deactivate(owner);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates pending initialization when leaving before a resource is installed", () => {
    const dispose = vi.fn();
    const lease = new ScreenSessionLease<object>(dispose, vi.fn());
    const owner = {};
    lease.activate(owner);
    lease.setReusable(0, true);
    lease.deactivate(owner);
    const lateResource = {};
    expect(lease.install(0, lateResource)).toBe(false);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(lateResource);
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: false, resource: null, reusable: false });
  });

  it("ignores an outgoing route's cleanup after a new route takes ownership", () => {
    const { lease, owner, resource, dispose, notify } = setup();
    const nextOwner = {};
    const snapshot = lease.getSnapshot();
    const notificationCount = notify.mock.calls.length;
    lease.activate(nextOwner);
    lease.deactivate(owner);
    expect(lease.getSnapshot()).toBe(snapshot);
    expect(notify).toHaveBeenCalledTimes(notificationCount);
    expect(vi.getTimerCount()).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
    lease.deactivate(nextOwner);
    expect(lease.getSnapshot()).toEqual({ generation: 0, active: false, resource, reusable: true });
  });

  it("ignores stale capabilities and disposes stale initialization after reset", () => {
    const { lease, resource, dispose, notify } = setup();
    lease.reset();
    const nextResource = {};
    expect(lease.install(1, nextResource)).toBe(true);
    lease.setReusable(1, true);
    const snapshot = lease.getSnapshot();
    const notificationCount = notify.mock.calls.length;
    lease.setReusable(0, false);
    lease.setReusable(0, true);
    const staleResource = {};
    expect(lease.install(0, staleResource)).toBe(false);
    expect(lease.getSnapshot()).toBe(snapshot);
    expect(notify).toHaveBeenCalledTimes(notificationCount);
    expect(dispose.mock.calls).toEqual([[resource], [staleResource]]);
    expect(lease.isCurrent(0)).toBe(false);
    expect(lease.isCurrent(1)).toBe(true);
  });

  it("resets a retained resource when its current capability is revoked", () => {
    const { lease, owner, resource, dispose } = setup();
    lease.deactivate(owner);
    lease.setReusable(0, false);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: false, resource: null, reusable: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not install a new resource into an inactive retained connection", () => {
    const { lease, owner, resource, dispose } = setup();
    lease.deactivate(owner);
    const lateResource = {};
    expect(lease.install(0, lateResource)).toBe(false);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(lateResource);
    expect(lease.getSnapshot().resource).toBe(resource);
  });

  it("gives each new departure a full retention window despite a canceled callback", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { lease, owner, resource, dispose } = setup();
    lease.deactivate(owner);
    const expiredCallback = timer.mock.calls[0][0] as () => void;
    vi.advanceTimersByTime(60_000);
    lease.activate(owner);
    lease.deactivate(owner);
    expiredCallback();
    expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(119_999);
    expect(lease.getSnapshot().resource).toBe(resource);
    expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
  });

  it("does not let an old expiry dispose a resource from a newer generation", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { lease, owner, resource, dispose } = setup();
    lease.deactivate(owner);
    const expiredCallback = timer.mock.calls[0][0] as () => void;
    lease.reset();
    lease.activate(owner);
    const nextResource = {};
    lease.install(1, nextResource);
    lease.setReusable(1, true);
    lease.deactivate(owner);
    expiredCallback();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(lease.getSnapshot().resource).toBe(nextResource);
  });

  it("forces a new generation on reset while preserving the active owner", () => {
    const { lease, owner, resource, dispose } = setup();
    lease.reset();
    expect(lease.getSnapshot()).toEqual({ generation: 1, active: true, resource: null, reusable: false });
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    lease.deactivate(owner);
    expect(lease.getSnapshot()).toEqual({ generation: 2, active: false, resource: null, reusable: false });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps snapshots stable and emits nothing for updates that change no exposed state", () => {
    const notify = vi.fn();
    const lease = new ScreenSessionLease<object>(vi.fn(), notify);
    const initial = lease.getSnapshot();
    expect(initial).toEqual({ generation: 0, active: false, resource: null, reusable: false });
    lease.setReusable(0, false);
    lease.deactivate({});
    expect(lease.getSnapshot()).toBe(initial);
    expect(notify).not.toHaveBeenCalled();

    const owner = {};
    const resource = {};
    lease.activate(owner);
    lease.install(0, resource);
    lease.setReusable(0, true);
    const installed = lease.getSnapshot();
    lease.activate(owner);
    lease.install(0, resource);
    lease.setReusable(0, true);
    expect(lease.getSnapshot()).toBe(installed);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("releases replaced resources and final disposal cancels retention", () => {
    const { lease, owner, resource, dispose } = setup();
    const replacement = {};
    expect(lease.install(0, replacement)).toBe(true);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    lease.deactivate(owner);
    lease.dispose();
    expect(dispose.mock.calls).toEqual([[resource], [replacement]]);
    expect(vi.getTimerCount()).toBe(0);
    const snapshot = lease.getSnapshot();
    lease.deactivate(owner);
    expect(lease.getSnapshot()).toBe(snapshot);
    expect(snapshot).toEqual({ generation: 1, active: false, resource: null, reusable: false });
  });
});
