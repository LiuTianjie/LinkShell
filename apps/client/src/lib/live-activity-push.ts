import { getRandomBytes } from "expo-crypto";
import { useEffect } from "react";
import { AppState } from "react-native";
import * as linkLayout from "../../modules/link-layout";
import { useAccount } from "./account";
import { useConnection } from "./client";
import { readSecret, writeSecret } from "./secure";

const KEY = "linkshell.live-activity.push.v1";

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
  pushToStart?: SavedPushToStart;
}

function readBundle(): SavedRegistrations {
  const saved = readSecret<SavedRegistrations | SavedRegistration>(KEY);
  if (!saved) return { records: [] };
  return "records" in saved ? saved : { records: [saved] };
}

function records(): SavedRegistration[] {
  return readBundle().records;
}

function save(record: SavedRegistration) {
  // Merge against the latest Keychain value: an old connection can finish a
  // registration while the newly selected computer is registering its own.
  const current = readBundle();
  writeSecret(KEY, {
    ...current,
    records: [...current.records.filter((item) => item.activityId !== record.activityId), record],
  });
}

function savePushToStart(pushToStart: SavedPushToStart | undefined) {
  const current = readBundle();
  writeSecret(KEY, {
    records: current.records,
    ...(pushToStart ? { pushToStart } : {}),
  });
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
    let generation = 0;
    const handedOff = new Map<string, number>();
    let revalidate = false;
    const obsolete = previous.filter((record) => record.owner !== owner || record.serviceUrl !== pushURL);
    const obsoletePushToStart =
      previousPushToStart && (previousPushToStart.owner !== owner || previousPushToStart.serviceUrl !== pushURL)
        ? previousPushToStart
        : undefined;
    if (obsolete.length || obsoletePushToStart) {
      writeSecret(KEY, {
        records: previous.filter((record) => !obsolete.includes(record)),
        ...(previousPushToStart && !obsoletePushToStart ? { pushToStart: previousPushToStart } : {}),
      });
      for (const record of obsolete) void revoke(record);
      if (obsoletePushToStart) void revokePushToStart(obsoletePushToStart);
    }
    const reset = obsolete.length ? linkLayout.endNativeLiveActivity() : Promise.resolve();

    const syncPushToStart = async (currentGeneration: number) => {
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
      if (!startToken || disposed || generation !== currentGeneration) return;

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
            deviceId: existing?.deviceId || `ios-${randomHex(12)}`,
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
        if (!authToken || disposed || generation !== currentGeneration || useAccount.getState().session?.userId !== owner) {
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
      if (useAccount.getState().session?.userId !== owner || generation !== currentGeneration) {
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
      const currentGeneration = generation;
      try {
        await reset;
        const nativeActivities = await linkLayout.getNativeLiveActivityRegistrations();
        if (disposed || generation !== currentGeneration) return;
        for (const native of nativeActivities) {
          try {
            const saved = records().find((record) => record.activityId === native.activityId);
            const currentComputer = native.computerKey === computer.key;
            // A known background computer already has its grant. Token rotation only
            // needs the push service; it must not wait for this phone to reconnect to it.
            if ((!currentComputer || link.status !== "online") && !saved) continue;
            if (saved?.ended) continue;
            const matching =
              saved?.activityId === native.activityId &&
              !saved.ended &&
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
              if (!token || disposed || generation !== currentGeneration || useAccount.getState().session?.userId !== owner) return;
              const response = await fetch(`${pushURL}/v1/activities/${record.activityId}`, {
                method: "PUT",
                headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ token: record.token, grant: record.grant }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!response.ok) continue;
              const result = (await response.json()) as { activityId?: string; expiresAt?: number };
              if (result.activityId !== record.activityId || !Number.isSafeInteger(result.expiresAt) || result.expiresAt! <= Date.now()) continue;
              record.expiresAt = result.expiresAt;
              record.registeredAt = Date.now();
            }
            if (useAccount.getState().session?.userId !== owner || generation !== currentGeneration) {
              void revoke(record);
              return;
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
              });
            }
            if (disposed || generation !== currentGeneration) return;
            if (currentComputer && link.status === "online") await linkLayout.setNativeLiveActivityPushReady(record.activityId);
            handedOff.set(signature, Date.now());
          } catch {
            /* One unreachable computer must not block the others. */
          }
        }
        try {
          await syncPushToStart(currentGeneration);
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
      handedOff.clear();
      if (event.ended) {
        // Invalidate even a native lookup that has not saved its first record yet.
        generation++;
        for (const record of records().filter((item) => !event.activityId || item.activityId === event.activityId)) {
          // Synchronous replacement cannot delete a new activity's grant in an async cleanup race.
          save({ ...record, ended: true });
          void revoke(record);
          if (record.computerKey === computer.key) {
            void link.call("liveActivities.unsubscribe", { activityId: record.activityId }).catch(() => {});
          }
        }
      } else {
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
