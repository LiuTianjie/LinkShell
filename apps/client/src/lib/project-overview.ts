import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { HostLink, TunnelSocket } from "@linkshell/client-core";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { accessToken } from "./client";
import { relayFor, type Computer } from "./computers";
import { deviceIdentity } from "./identity";
import { createSocket } from "./socket";
import { useAccount } from "./account";

export interface ProjectOverview {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  loaded: boolean;
  partial: boolean;
  error?: string;
}

const emptyOverview = (): ProjectOverview => ({ projects: [], sessions: [], loaded: false, partial: false });

/** Read-only project summaries never replace the selected computer or start media streams. */
export function useProjectOverview(computer: Computer, enabled: boolean): ProjectOverview {
  const accountId = useAccount((state) => state.session?.userId);
  const identity = JSON.stringify([accountId, computer.key, computer.kind === "relay" ? computer.machine.signKey : computer.url]);
  const [snapshot, setSnapshot] = useState<{ identity: string; overview: ProjectOverview }>(() => ({ identity, overview: emptyOverview() }));
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let close: (() => void) | undefined;
    const update = (change: (current: ProjectOverview) => ProjectOverview) => {
      if (!disposed) setSnapshot((current) => ({ identity, overview: change(current.identity === identity ? current.overview : emptyOverview()) }));
    };
    const start = () => {
      if (close || disposed || AppState.currentState === "background") return;
      // Account discovery may still be finishing sign-out while its old rows are removed.
      if (computer.kind === "relay" && computer.machine.via === "account" && !accountId) {
        update(() => ({ ...emptyOverview(), error: "登录对应账号后可查看这台电脑的项目" }));
        return;
      }
      if (computer.kind === "relay" && !computer.machine.online) {
        update(() => ({ ...emptyOverview(), error: "电脑离线，连接后可查看项目" }));
        return;
      }
      const link = computer.kind === "direct"
        ? new HostLink({ url: computer.url, createSocket, lazyImages: true, accessToken: accessToken(computer) })
        : new HostLink({
          url: computer.key,
          createSocket: () => new TunnelSocket(relayFor(computer.gateway), deviceIdentity(), computer.machine),
          lazyImages: true,
          accessToken: accessToken(computer),
        });
      let stopped = false;
      let refreshing = false;
      const duringRefresh = new Map<string, SessionSummary>();
      const refresh = async () => {
        if (refreshing || stopped) return;
        refreshing = true;
        duringRefresh.clear();
        try {
          const [projects, sessions] = await Promise.all([
            link.call("projects.list", { limit: 200 }, 15_000),
            link.call("sessions.list", { limit: 200 }, 15_000),
          ]);
          if (!stopped) {
            // A live summary may arrive after the snapshot was read but before its response.
            const latest = new Map(sessions.sessions.map((session) => [session.id, session]));
            for (const [id, session] of duringRefresh) latest.set(id, session);
            const next = { projects: projects.projects, sessions: [...latest.values()], loaded: true, partial: sessions.nextBefore !== undefined || projects.projects.length === 200 };
            update(() => next);
          }
        } catch (error) {
          if (!stopped) update((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
        } finally {
          refreshing = false;
        }
      };
      const removeOnline = link.onOnline(() => void refresh());
      const removeStatus = link.onStatus((status) => {
        if (stopped) return;
        if (status === "locked") update(() => ({ ...emptyOverview(), error: "请先输入这台电脑的访问密码" }));
        else if (status === "reconnecting") update((current) => ({ ...current, error: current.loaded ? "连接已中断，正在恢复；以下为上次读取的项目" : "正在重新连接电脑…" }));
      });
      const removeSummary = link.onSummary((summary) => {
        if (stopped) return;
        if (refreshing) duringRefresh.set(summary.id, summary);
        update((current) => ({ ...current, sessions: [summary, ...current.sessions.filter((session) => session.id !== summary.id)] }));
      });
      const timer = setInterval(() => void refresh(), 30_000);
      close = () => {
        stopped = true;
        clearInterval(timer);
        removeOnline();
        removeStatus();
        removeSummary();
        link.stop();
        close = undefined;
      };
      update((current) => ({ ...current, error: undefined }));
      link.start();
      void refresh();
    };
    start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") start();
      else if (state === "background") close?.();
    });
    return () => {
      disposed = true;
      close?.();
      subscription.remove();
    };
  }, [computer, enabled, identity, accountId]);
  return snapshot.identity === identity ? snapshot.overview : emptyOverview();
}
