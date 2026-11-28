import { getRandomBytes } from "expo-crypto";
import { useEffect } from "react";
import { AppState } from "react-native";
import * as linkLayout from "../../modules/link-layout";
import { useAccount } from "./account";
import { useConnection } from "./client";
import { reconnectRelays } from "./computers";
import { readSecret, writeSecret } from "./secure";

const KEY = "linkshell.live-activity.push.v1";
const MAX_SAVED_RECORDS = 16;
const MAX_ENDED_CACHE = 64;
const ENDED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface SavedRegistration {
  activityId: string;
  computerKey: string;
  token: string;
  grant: string;
  owner: string;
  serviceUrl: string;
  expiresAt?: number;
  registeredAt?: number;
  ended?: boolean;
}

interface SavedPushToStart {
  deviceId: string;
  token: string;
  grant: string;
  owner: string;
  serviceUrl: string;
  computerKey: string;
  expiresAt?: number;
  registeredAt?: number;
}

interface SavedRegistrations {
  records: SavedRegistration[];
  deviceId?: string;
  pushToStart?: SavedPushToStart;
}

function pruneRecords(items: SavedRegistration[], now = Date.now()): SavedRegistration[] {
  const active = items.filter((item) => !item.ended && (item.expiresAt === undefined || item.expiresAt > now));
  if (active.length <= MAX_SAVED_RECORDS) return active;
  return active
    .slice()
    .sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))
    .slice(0, MAX_SAVED_RECORDS);
}

function readBundle(): SavedRegistrations {
  const saved = readSecret<SavedRegistrations | SavedRegistration>(KEY);
  if (!saved) return { records: [] };
  return "records" in saved ? saved : { records: [saved] };
}

function records(): SavedRegistration[] {
  return pruneRecords(readBundle().records);
}

function writeBundle(bundle: SavedRegistrations) {
  writeSecret(KEY, {
    records: pruneRecords(bundle.records),
    ...(bundle.deviceId ? { deviceId: bundle.deviceId } : {}),
    ...(bundle.pushToStart ? { pushToStart: bundle.pushToStart } : {}),
  });
}

function save(record: SavedRegistration) {
  // Merge against the latest Keychain value: an old connection can finish a
  // registration while the newly selected computer is registering its own.
  const current = readBundle();
  writeBundle({
    ...current,
    records: [...current.records.filter((item) => item.activityId !== record.activityId), record],
  });
}

function removeRecords(predicate: (record: SavedRegistration) => boolean): SavedRegistration[] {
  const current = readBundle();
  const removed: SavedRegistration[] = [];
  const kept: SavedRegistration[] = [];
  for (const item of current.records) {
    if (predicate(item)) removed.push(item);
    else kept.push(item);
  }
  if (removed.length || kept.length !== pruneRecords(kept).length) {
    writeBundle({ ...current, records: kept });
  }
  return removed;
}

function savePushToStart(pushToStart: SavedPushToStart | undefined) {
  const current = readBundle();
  writeBundle({
    ...current,
    ...(pushToStart ? { deviceId: pushToStart.deviceId, pushToStart } : { pushToStart: undefined }),
  });
}

function ensureDeviceId(): string {
  const current = readBundle();
  const existing = current.deviceId || current.pushToStart?.deviceId;
  if (existing) return existing;
  const generated = `ios-${randomHex(12)}`;
  writeBundle({ ...current, deviceId: generated });
  return generated;
}

function randomHex(bytes: number): string {
  return Array.from(getRandomBytes(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function revoke(record: SavedRegistration) {
  try {
    await fetch(`${record.serviceUrl}/v1/activities/${record.activityId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${record.grant}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* Every server grant also expires; logging out never waits for a push service. */
  }
}

async function revokePushToStart(record: SavedPushToStart) {
  try {
    await fetch(`${record.serviceUrl}/v1/push-to-start/${encodeURIComponent(record.deviceId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${record.grant}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* Best-effort revocation on logout or service switch. */
  }
}

/**
 * Registers both per-activity ActivityKit tokens and iOS 17.2+ `pushToStartToken`
 * so a task started from Mac can wake Dynamic Island even if the app wasn't opened beforehand.
 */
export function useLiveActivityPush() {
  const { computer, link } = useConnection();
  const owner = useAccount((state) => state.session?.userId);
  useEffect(() => {
    const pushURL = linkLayout.liveActivityPushURL;
    if (!pushURL) return;
    const bundle = readBundle();
    const previous = bundle.records;
    const previousPushToStart = bundle.pushToStart;
    if (!owner) {
      if (previous.length || previousPushToStart) {
        // A late async Keychain deletion could erase a new login's registration.
        writeSecret(KEY, null);
        for (const record of previous) void revoke(record);
        if (previousPushToStart) void revokePushToStart(previousPushToStart);
        // Only reset activities delegated to a signed-out account's remote push grant;
        // non-account / QR-paired users simply skip APNs registration and keep local Live Activities.
        if (previous.length) void linkLayout.endNativeLiveActivity();
      }
      return;
    }
    let disposed = false;
    let busy = false;
    let pending = false;
    let globalGeneration = 0;
    const activityGenerations = new Map<string, number>();
    const endedIds = new Map<string, number>();
    const handedOff = new Map<string, number>();
    let revalidate = false;

    const markEnded = (activityId: string) => {
      const now = Date.now();
      for (const [id, at] of endedIds) {
        if (now - at > ENDED_CACHE_TTL_MS) endedIds.delete(id);
      }
      endedIds.delete(activityId);
      endedIds.set(activityId, now);
      while (endedIds.size > MAX_ENDED_CACHE) {
        const oldest = endedIds.keys().next().value;
        if (oldest === undefined) break;
        endedIds.delete(oldest);
      }
    };
    const isEnded = (activityId: string) => {
      const at = endedIds.get(activityId);
      if (at === undefined) return false;
      if (Date.now() - at > ENDED_CACHE_TTL_MS) {
        endedIds.delete(activityId);
        return false;
      }
      return true;
    };

    const prunedPrevious = pruneRecords(previous);
    const obsolete = prunedPrevious.filter((record) => record.owner !== owner || record.serviceUrl !== pushURL);
    const obsoletePushToStart =
      previousPushToStart && (previousPushToStart.owner !== owner || previousPushToStart.serviceUrl !== pushURL)
        ? previousPushToStart
        : undefined;
    if (obsolete.length || obsoletePushToStart || prunedPrevious.length !== previous.length) {
      writeBundle({
        ...bundle,
        records: prunedPrevious.filter((record) => !obsolete.includes(record)),
        ...(previousPushToStart && !obsoletePushToStart ? { pushToStart: previousPushToStart } : { pushToStart: undefined }),
      });
      for (const record of obsolete) void revoke(record);
      if (obsoletePushToStart) void revokePushToStart(obsoletePushToStart);
    }
    const reset = obsolete.length ? linkLayout.endNativeLiveActivity() : Promise.resolve();

    const syncPushToStart = async (startGlobal: number) => {
      let getPushToStart: (() => Promise<string | null>) | undefined;
      try {
        if ("getNativeLiveActivityPushToStartToken" in linkLayout) {
          getPushToStart = linkLayout.getNativeLiveActivityPushToStartToken;
        }
      } catch {
        return;
      }
      if (!getPushToStart) return;
      if (!computer.key || link.status !== "online") return;
      const startToken = await getPushToStart();
      if (!startToken || disposed || globalGeneration !== startGlobal) return;

      const existing = readBundle().pushToStart;
      const matching =
        existing &&
        existing.owner === owner &&
        existing.serviceUrl === pushURL &&
        existing.computerKey === computer.key;
      if (existing && !matching && existing.owner === owner && existing.serviceUrl !== pushURL) {
        void revokePushToStart(existing);
      }
      const sameToken = Boolean(matching && existing.token === startToken);
      const record: SavedPushToStart = matching
        ? {
            ...existing,
            token: startToken,
            expiresAt: sameToken ? existing.expiresAt : undefined,
            registeredAt: sameToken ? existing.registeredAt : undefined,
          }
        : {
            deviceId: ensureDeviceId(),
            token: startToken,
            grant: existing?.grant || randomHex(32),
            owner,
            serviceUrl: pushURL,
            computerKey: computer.key,
          };

      const signature = `pushToStart:${record.computerKey}:${record.token}`;
      if (!revalidate && Date.now() - (handedOff.get(signature) ?? 0) < 30_000) return;
      if (revalidate) record.registeredAt = undefined;
      savePushToStart(record);

      const registered =
        !revalidate &&
        sameToken &&
        (record.expiresAt ?? 0) > Date.now() &&
        Date.now() - (record.registeredAt ?? 0) < 5 * 60_000;
      if (!registered) {
        const authToken = await useAccount.getState().token();
        if (!authToken || disposed || globalGeneration !== startGlobal || useAccount.getState().session?.userId !== owner) {
          return;
        }
        try {
          const response = await fetch(`${pushURL}/v1/push-to-start/${encodeURIComponent(record.deviceId)}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${authToken}`, "content-type": "application/json" },
            body: JSON.stringify({ token: record.token, grant: record.grant, platform: "ios" }),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            const result = (await response.json()) as { expiresAt?: number };
            if (Number.isSafeInteger(result.expiresAt) && result.expiresAt! > Date.now()) {
              record.expiresAt = result.expiresAt;
            }
          } else if (response.status !== 404) {
            return;
          }
        } catch {
          return;
        }
        if (!record.expiresAt || record.expiresAt <= Date.now()) {
          record.expiresAt = Date.now() + 24 * 3_600_000;
        }
        record.registeredAt = Date.now();
      }
      if (useAccount.getState().session?.userId !== owner || globalGeneration !== startGlobal) {
        void revokePushToStart(record);
        return;
      }
      if (disposed) return;
      savePushToStart(record);
      if (link.status === "online") {
        await link.call("liveActivities.registerPushToStart", {
          deviceId: record.deviceId,
          pushToStartToken: record.token,
          platform: "ios",
          serviceUrl: pushURL,
          grant: record.grant,
          expiresAt: record.expiresAt!,
          computerKey: computer.key,
        });
        handedOff.set(signature, Date.now());
      }
    };

    const check = async () => {
      if (disposed) return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      const startGlobal = globalGeneration;
      const startActivityGens = new Map(activityGenerations);
      try {
        await reset;
        const nativeActivities = await linkLayout.getNativeLiveActivityRegistrations();
        if (disposed || globalGeneration !== startGlobal) return;
        for (const native of nativeActivities) {
          const startActivity = startActivityGens.get(native.activityId) ?? 0;
          const invalidated = () =>
            globalGeneration !== startGlobal
            || (activityGenerations.get(native.activityId) ?? 0) !== startActivity
            || isEnded(native.activityId);
          try {
            if (invalidated()) continue;
            const saved = records().find((record) => record.activityId === native.activityId);
            const currentComputer = native.computerKey === computer.key;
            // Do not register an unknown activity belonging to another computer.
            if (!currentComputer && !saved) continue;
            // A push-to-start activity woken while suspended may arrive while the E2E link is
            // still reconnecting: wake the relay + host link right away AND register the new
            // activity token with the push service so Host handoff completes as soon as online.
            if (currentComputer && link.status !== "online") {
              try {
                reconnectRelays();
                (link as { reconnectNow?: () => void }).reconnectNow?.();
              } catch {
                /* Best-effort wakeup during background registration. */
              }
            }
            const deviceId = ensureDeviceId();
            const matching =
              saved?.activityId === native.activityId &&
              saved.computerKey === native.computerKey &&
              saved.owner === owner &&
              saved.serviceUrl === pushURL;
            if (saved && !matching) void revoke(saved);
            const sameToken = matching && saved.token === native.token;
            const record: SavedRegistration = matching
              ? {
                  ...saved,
                  token: native.token,
                  expiresAt: sameToken ? saved.expiresAt : undefined,
                  registeredAt: sameToken ? saved.registeredAt : undefined,
                }
              : {
                  ...native,
                  grant: randomHex(32),
                  owner,
                  serviceUrl: pushURL,
                };
            const signature = `${record.activityId}:${record.token}`;
            if (!revalidate && Date.now() - (handedOff.get(signature) ?? 0) < 30_000) continue;
            // Persist before the request, so a lost response can retry the same grant.
            if (revalidate) record.registeredAt = undefined;
            save(record);
            // A brief socket reconnect must not discard a completed registration or
            // wait for account verification again before handing the grant to Host.
            const registered =
              !revalidate &&
              sameToken &&
              (record.expiresAt ?? 0) > Date.now() &&
              Date.now() - (record.registeredAt ?? 0) < 5 * 60_000;
            if (!registered) {
              const token = await useAccount.getState().token();
              if (!token || disposed || globalGeneration !== startGlobal || useAccount.getState().session?.userId !== owner) return;
              if (invalidated()) {
                void revoke(record);
                continue;
              }
              let response = await fetch(`${pushURL}/v1/activities/${record.activityId}`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({
                  token: record.token,
                  grant: record.grant,
                  computerKey: record.computerKey,
                  deviceId,
                }),
                signal: AbortSignal.timeout(10_000),
              });
              // Older push services enforce a strict { token, grant } schema; fall back once on 400.
              if (response.status === 400) {
                response = await fetch(`${pushURL}/v1/activities/${record.activityId}`, {
                  method: "PUT",
                  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
                  body: JSON.stringify({ token: record.token, grant: record.grant }),
                  signal: AbortSignal.timeout(10_000),
                });
              }
              if (!response.ok) continue;
              const result = (await response.json()) as { activityId?: string; expiresAt?: number };
              if (result.activityId !== record.activityId || !Number.isSafeInteger(result.expiresAt) || result.expiresAt! <= Date.now()) continue;
              record.expiresAt = result.expiresAt;
              record.registeredAt = Date.now();
            }
            if (useAccount.getState().session?.userId !== owner || globalGeneration !== startGlobal) {
              void revoke(record);
              return;
            }
            if (invalidated()) {
              void revoke(record);
              continue;
            }
            if (disposed) return;
            save(record);
            if (currentComputer && link.status === "online") {
              await link.call("liveActivities.subscribe", {
                activityId: record.activityId,
                computerKey: record.computerKey,
                serviceUrl: pushURL,
                grant: record.grant,
                expiresAt: record.expiresAt!,
                deviceId,
              });
            }
            if (disposed || globalGeneration !== startGlobal) return;
            if (invalidated()) continue;
            if (currentComputer && link.status === "online") {
              await linkLayout.setNativeLiveActivityPushReady(record.activityId);
              handedOff.set(signature, Date.now());
            } else if (!currentComputer) {
              handedOff.set(signature, Date.now());
            }
          } catch {
            /* One unreachable computer must not block the others. */
          }
        }
        try {
          await syncPushToStart(startGlobal);
        } catch {
          /* Push-to-start failure never blocks active Live Activity updates. */
        }
        revalidate = false;
      } catch {
        /* Retry while foregrounded; never print tokens or grants. */
      } finally {
        busy = false;
        if (pending) {
          pending = false;
          void check();
        }
      }
    };
    const off = linkLayout.subscribeNativeLiveActivityTokens((event) => {
      if (event.ended) {
        if (event.activityId) {
          // Scope invalidation strictly to this activityId so ending activity #1
          // never cancels or revokes an in-flight registration for activity #2.
          activityGenerations.set(event.activityId, (activityGenerations.get(event.activityId) ?? 0) + 1);
          markEnded(event.activityId);
          for (const key of [...handedOff.keys()]) {
            if (key.startsWith(`${event.activityId}:`)) handedOff.delete(key);
          }
        } else {
          globalGeneration++;
          handedOff.clear();
        }
        const removed = removeRecords((item) => !event.activityId || item.activityId === event.activityId);
        for (const record of removed) {
          markEnded(record.activityId);
          void revoke(record);
          if (record.computerKey === computer.key) {
            void link.call("liveActivities.unsubscribe", { activityId: record.activityId }).catch(() => {});
          }
        }
      } else {
        handedOff.clear();
        void check();
      }
    });
    let offStart = () => {};
    try {
      if ("subscribeNativeLiveActivityPushToStartToken" in linkLayout && linkLayout.subscribeNativeLiveActivityPushToStartToken) {
        offStart = linkLayout.subscribeNativeLiveActivityPushToStartToken(() => {
          handedOff.clear();
          void check();
        });
      }
    } catch {
      /* Partial test mocks without pushToStart exports remain supported. */
    }
    const offOnline = link.onOnline(() => {
      handedOff.clear();
      void check();
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        handedOff.clear();
        revalidate = true;
        void check();
      }
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void check();
    }, 20_000);
    void check();
    return () => {
      disposed = true;
      off();
      offStart();
      offOnline();
      appState.remove();
      clearInterval(timer);
    };
  }, [owner, computer.key, link]);
}
