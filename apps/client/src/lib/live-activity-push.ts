import { getRandomBytes } from "expo-crypto";
import { useEffect } from "react";
import { AppState } from "react-native";
import {
  endNativeLiveActivity, getNativeLiveActivityRegistration, liveActivityPushURL,
  setNativeLiveActivityPushReady, subscribeNativeLiveActivityTokens,
} from "../../modules/link-layout";
import { useAccount } from "./account";
import { useClient, useConnection } from "./client";
import { readSecret, writeSecret } from "./secure";

const KEY = "linkshell.live-activity.push.v1";
interface SavedRegistration {
  activityId: string; computerKey: string; token: string; grant: string;
  owner: string; serviceUrl: string; expiresAt?: number; ended?: boolean;
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
  const online = useClient((state) => state.status === "online");
  const owner = useAccount((state) => state.session?.userId);
  useEffect(() => {
    if (!liveActivityPushURL) return;
    const previous = readSecret<SavedRegistration>(KEY);
    if (!owner) {
      if (previous) {
        // A late async Keychain deletion could erase a new login's registration.
        writeSecret(KEY, null);
        void revoke(previous);
        void endNativeLiveActivity();
      }
      return;
    }
    let disposed = false;
    let busy = false;
    let pending = false;
    let generation = 0;
    let handedOff = "";
    const check = async () => {
      if (disposed || !online) return;
      if (busy) { pending = true; return; }
      busy = true;
      const currentGeneration = generation;
      try {
        const native = await getNativeLiveActivityRegistration();
        if (disposed || generation !== currentGeneration) return;
        const saved = readSecret<SavedRegistration>(KEY);
        if (!native) return;
        if (native.computerKey !== computer.key) return;
        const matching = saved?.activityId === native.activityId && !saved.ended && saved.computerKey === computer.key && saved.owner === owner && saved.serviceUrl === liveActivityPushURL;
        if (saved && !matching) void revoke(saved);
        const record: SavedRegistration = matching ? { ...saved, token: native.token } : {
          ...native, grant: Array.from(getRandomBytes(32), (value) => value.toString(16).padStart(2, "0")).join(""),
          owner, serviceUrl: liveActivityPushURL,
        };
        const signature = `${record.activityId}:${record.token}`;
        if (handedOff === signature) return;
        // Persist before the request, so a lost response can retry the same grant.
        writeSecret(KEY, record);
        const token = await useAccount.getState().token();
        if (!token || disposed || generation !== currentGeneration || useAccount.getState().session?.userId !== owner) return;
        const response = await fetch(`${liveActivityPushURL}/v1/activities/${record.activityId}`, {
          method: "PUT", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ token: record.token, grant: record.grant }), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return;
        const result = await response.json() as { activityId?: string; expiresAt?: number };
        if (result.activityId !== record.activityId || !Number.isSafeInteger(result.expiresAt) || result.expiresAt! <= Date.now()) return;
        if (useAccount.getState().session?.userId !== owner || generation !== currentGeneration) { void revoke(record); return; }
        if (disposed) return;
        record.expiresAt = result.expiresAt;
        writeSecret(KEY, record);
        await link.call("liveActivities.subscribe", {
          activityId: record.activityId, computerKey: record.computerKey, serviceUrl: liveActivityPushURL,
          grant: record.grant, expiresAt: record.expiresAt!,
        });
        if (disposed || generation !== currentGeneration) return;
        await setNativeLiveActivityPushReady(record.activityId);
        handedOff = signature;
      } catch { /* Retry while foregrounded; never print tokens or grants. */ }
      finally { busy = false; if (pending) { pending = false; void check(); } }
    };
    const off = subscribeNativeLiveActivityTokens((event) => {
      handedOff = "";
      if (event.ended) {
        // Invalidate even a native lookup that has not saved its first record yet.
        generation++;
        const record = readSecret<SavedRegistration>(KEY);
        if (record && (!event.activityId || record.activityId === event.activityId)) {
          // Synchronous replacement cannot delete a new activity's grant in an async cleanup race.
          writeSecret(KEY, { ...record, ended: true });
          void revoke(record);
          if (record.computerKey === computer.key) void link.call("liveActivities.unsubscribe", { activityId: record.activityId }).catch(() => {});
        }
      } else { void check(); }
    });
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") { handedOff = ""; void check(); } });
    const timer = setInterval(() => { if (AppState.currentState === "active") void check(); }, 20_000);
    void check();
    return () => { disposed = true; off(); appState.remove(); clearInterval(timer); };
  }, [owner, online, computer.key, link]);
}
