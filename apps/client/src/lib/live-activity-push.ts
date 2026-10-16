import { getRandomBytes } from "expo-crypto";
import { useEffect } from "react";
import { AppState } from "react-native";
import {
  endNativeLiveActivity, getNativeLiveActivityRegistrations, liveActivityPushURL,
  setNativeLiveActivityPushReady, subscribeNativeLiveActivityTokens,
} from "../../modules/link-layout";
import { useAccount } from "./account";
import { useConnection } from "./client";
import { readSecret, writeSecret } from "./secure";

const KEY = "linkshell.live-activity.push.v1";
interface SavedRegistration {
  activityId: string; computerKey: string; token: string; grant: string;
  owner: string; serviceUrl: string; expiresAt?: number; registeredAt?: number; ended?: boolean;
}

interface SavedRegistrations { records: SavedRegistration[] }
function records(): SavedRegistration[] {
  const saved = readSecret<SavedRegistrations | SavedRegistration>(KEY);
  if (!saved) return [];
  return "records" in saved ? saved.records : [saved];
}
function save(record: SavedRegistration) {
  // Merge against the latest Keychain value: an old connection can finish a
  // registration while the newly selected computer is registering its own.
  writeSecret(KEY, { records: [...records().filter((item) => item.activityId !== record.activityId), record] });
}

async function revoke(record: SavedRegistration) {
  try {
    await fetch(`${record.serviceUrl}/v1/activities/${record.activityId}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${record.grant}` }, signal: AbortSignal.timeout(10_000),
    });
  } catch { /* Every server grant also expires; logging out never waits for a push service. */ }
}

/** Registers only the ActivityKit token; no normal APNs device-token or notification permission. */
export function useLiveActivityPush() {
  const { computer, link } = useConnection();
  const owner = useAccount((state) => state.session?.userId);
  useEffect(() => {
    if (!liveActivityPushURL) return;
    const previous = records();
    if (!owner) {
      if (previous.length) {
        // A late async Keychain deletion could erase a new login's registration.
        writeSecret(KEY, null);
        for (const record of previous) void revoke(record);
      }
      void endNativeLiveActivity();
      return;
    }
    let disposed = false;
    let busy = false;
    let pending = false;
    let generation = 0;
    const handedOff = new Map<string, number>();
    let revalidate = false;
    const obsolete = previous.filter((record) => record.owner !== owner || record.serviceUrl !== liveActivityPushURL);
    if (obsolete.length) {
      writeSecret(KEY, { records: previous.filter((record) => !obsolete.includes(record)) });
      for (const record of obsolete) void revoke(record);
    }
    const reset = obsolete.length ? endNativeLiveActivity() : Promise.resolve();
    const check = async () => {
      if (disposed) return;
      if (busy) { pending = true; return; }
      busy = true;
      const currentGeneration = generation;
      try {
        await reset;
        const nativeActivities = await getNativeLiveActivityRegistrations();
        if (disposed || generation !== currentGeneration) return;
        for (const native of nativeActivities) {
          try {
            const saved = records().find((record) => record.activityId === native.activityId);
            const currentComputer = native.computerKey === computer.key;
            // A known background computer already has its grant. Token rotation only
            // needs the push service; it must not wait for this phone to reconnect to it.
            if ((!currentComputer || link.status !== "online") && !saved) continue;
            if (saved?.ended) continue;
            const matching = saved?.activityId === native.activityId && !saved.ended && saved.computerKey === native.computerKey && saved.owner === owner && saved.serviceUrl === liveActivityPushURL;
            if (saved && !matching) void revoke(saved);
            const sameToken = matching && saved.token === native.token;
            const record: SavedRegistration = matching ? {
              ...saved, token: native.token,
              expiresAt: sameToken ? saved.expiresAt : undefined,
              registeredAt: sameToken ? saved.registeredAt : undefined,
            } : {
              ...native, grant: Array.from(getRandomBytes(32), (value) => value.toString(16).padStart(2, "0")).join(""),
              owner, serviceUrl: liveActivityPushURL,
            };
            const signature = `${record.activityId}:${record.token}`;
            if (!revalidate && Date.now() - (handedOff.get(signature) ?? 0) < 30_000) continue;
            // Persist before the request, so a lost response can retry the same grant.
            if (revalidate) record.registeredAt = undefined;
            save(record);
            // A brief socket reconnect must not discard a completed registration or
            // wait for account verification again before handing the grant to Host.
            const registered = !revalidate && sameToken && (record.expiresAt ?? 0) > Date.now()
              && Date.now() - (record.registeredAt ?? 0) < 5 * 60_000;
            if (!registered) {
              const token = await useAccount.getState().token();
              if (!token || disposed || generation !== currentGeneration || useAccount.getState().session?.userId !== owner) return;
              const response = await fetch(`${liveActivityPushURL}/v1/activities/${record.activityId}`, {
                method: "PUT", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ token: record.token, grant: record.grant }), signal: AbortSignal.timeout(10_000),
              });
              if (!response.ok) continue;
              const result = await response.json() as { activityId?: string; expiresAt?: number };
              if (result.activityId !== record.activityId || !Number.isSafeInteger(result.expiresAt) || result.expiresAt! <= Date.now()) continue;
              record.expiresAt = result.expiresAt;
              record.registeredAt = Date.now();
            }
            if (useAccount.getState().session?.userId !== owner || generation !== currentGeneration) { void revoke(record); return; }
            if (disposed) return;
            save(record);
            if (currentComputer && link.status === "online") await link.call("liveActivities.subscribe", {
              activityId: record.activityId, computerKey: record.computerKey, serviceUrl: liveActivityPushURL,
              grant: record.grant, expiresAt: record.expiresAt!,
            });
            if (disposed || generation !== currentGeneration) return;
            if (currentComputer && link.status === "online") await setNativeLiveActivityPushReady(record.activityId);
            handedOff.set(signature, Date.now());
          } catch { /* One unreachable computer must not block the others. */ }
        }
        revalidate = false;
      } catch { /* Retry while foregrounded; never print tokens or grants. */ }
      finally { busy = false; if (pending) { pending = false; void check(); } }
    };
    const off = subscribeNativeLiveActivityTokens((event) => {
      handedOff.clear();
      if (event.ended) {
        // Invalidate even a native lookup that has not saved its first record yet.
        generation++;
        for (const record of records().filter((item) => !event.activityId || item.activityId === event.activityId)) {
          // Synchronous replacement cannot delete a new activity's grant in an async cleanup race.
          save({ ...record, ended: true });
          void revoke(record);
          if (record.computerKey === computer.key) void link.call("liveActivities.unsubscribe", { activityId: record.activityId }).catch(() => {});
        }
      } else { void check(); }
    });
    const offOnline = link.onOnline(() => { handedOff.clear(); void check(); });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") { handedOff.clear(); revalidate = true; void check(); }
    });
    const timer = setInterval(() => { if (AppState.currentState === "active") void check(); }, 20_000);
    void check();
    return () => { disposed = true; off(); offOnline(); appState.remove(); clearInterval(timer); };
  }, [owner, computer.key, link]);
}
