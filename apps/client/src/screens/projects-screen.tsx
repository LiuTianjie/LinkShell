import { groupProjects, type ProjectGroup } from "@linkshell/client-core";
import { router, Stack, useIsFocused } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/fixed-text";
import { AdaptiveGrid, usePageInsets } from "@/components/adaptive-page";
import { HeaderActions } from "@/components/header-actions";
import { hasSideToolbar } from "@/lib/home-layout";
import { useContentWidth } from "@/lib/content-width";
import { ConnectionBanner } from "@/components/connection-banner";
import { BranchTag } from "@/components/branch-tag";
import { Icon } from "@/components/icon";
import { ListRow, positionOf, type RowPosition } from "@/components/session-row";
import { EmptyState, LoadingState, unreachable, WaitingForComputer } from "@/components/state-views";
import { useClient, useConnection, useConnectionStatus, useHasComputer } from "@/lib/client";
import { listComputers, useComputers, type Computer } from "@/lib/computers";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { useProjectOverview, type ProjectOverview } from "@/lib/project-overview";
import { Welcome } from "@/components/welcome";
import { relativeTime, shortPath } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { NEW_SESSION } from "@/components/new-session-action";
import { PageSearch, StatusBarFade } from "@/components/page-header";
import { type } from "@/theme/type";

function openProject(project: ProjectGroup, computerKey?: string) {
  if (computerKey) useComputers.getState().select(computerKey);
  router.push({ pathname: "/projects/detail", params: { cwd: project.cwd, ...(project.generated ? { generated: "1" } : {}), ...(computerKey ? { computerKey } : {}) } });
}

function activityOf(project: ProjectGroup): string {
  const waiting = project.sessions.filter((session) => session.state === "waiting" || session.pendingPermissions > 0 || Boolean(session.asyncQuestions?.length)).length;
  const running = project.sessions.filter((session) => session.state === "running").length;
  return [waiting ? `${waiting} 待处理` : "", running ? `${running} 进行中` : ""].filter(Boolean).join(" · ");
}

function ProjectCard({ project, now, computerKey }: { project: ProjectGroup; now: number; computerKey?: string }) {
  return (
    <Pressable
      onPress={() => openProject(project, computerKey)}
      accessibilityRole="button"
      accessibilityLabel={`${project.name}，${project.sessionCount} 个会话`}
      style={({ pressed }) => ({
        padding: 20, gap: 18, minHeight: 188, borderRadius: 24, borderCurve: "continuous",
        backgroundColor: pressed ? colors.fill : colors.card,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon sf={project.generated ? "bubble.left.and.bubble.right.fill" : "square.stack.3d.up.fill"} md={project.generated ? "forum" : "stacks"} size={24} color={colors.accent} />
        </View>
        <Text style={[type.footnote, { flex: 1, textAlign: "right", color: colors.secondaryLabel }]}>{relativeTime(project.lastActiveAt, now)}</Text>
        <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} />
      </View>
      <View style={{ gap: 5 }}>
        <Text numberOfLines={2} style={[type.title3, { color: colors.label }]}>{project.name}</Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={[type.footnote, { color: colors.secondaryLabel }]}>{project.generated ? "Codex 自动创建的会话目录" : shortPath(project.cwd)}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: "auto" }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{project.sessionCount} 个会话</Text>
        {activityOf(project) ? <Text style={[type.footnote, { color: colors.accent }]}>{activityOf(project)}</Text> : null}
        {project.branch ? <BranchTag branch={project.branch} size={13} max={24} /> : null}
      </View>
    </Pressable>
  );
}

function parentOf(path: string): string {
  const cut = path.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return cut > 0 ? path.slice(0, cut) : path;
}

function ProjectRow({ project, position, now, computerKey }: { project: ProjectGroup; position: RowPosition; now: number; computerKey?: string }) {
  return (
    <ListRow
      leading={<Icon sf={project.generated ? "bubble.left.and.bubble.right.fill" : "square.stack.3d.up.fill"} md={project.generated ? "forum" : "stacks"} size={20} color={colors.accent} />}
      title={project.name}
      titleTag={project.branch ? <BranchTag branch={project.branch} size={13} max={20} /> : undefined}
      time={relativeTime(project.lastActiveAt, now)}
      // The folder it is in, not its own name again: enough to tell two of one name apart.
      detail={`${project.generated ? "Codex 自动创建" : parentOf(shortPath(project.cwd))} · ${project.sessionCount} 个会话${activityOf(project) ? ` · ${activityOf(project)}` : ""}`}
      position={position}
      onPress={() => openProject(project, computerKey)}
      accessibilityLabel={`${project.name}，${project.sessionCount} 个会话`}
    />
  );
}

function ComputerProjects({ computer, current, enabled, query, now, wide }: {
  computer: Computer;
  current?: ProjectOverview;
  enabled: boolean;
  query: string;
  now: number;
  wide: boolean;
}) {
  const remote = useProjectOverview(computer, enabled && !current);
  const overview = current ?? remote;
  const names = useComputerNames((state) => state.names);
  const name = computerDisplayName(computer, names);
  const projects = groupProjects(overview.projects, overview.sessions).filter((project) => !query || `${name} ${project.name} ${project.cwd} ${project.paths.join(" ")}`.toLowerCase().includes(query));
  return (
    <View style={{ gap: 8, marginTop: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
        <Icon sf="laptopcomputer" md="computer" size={18} color={colors.secondaryLabel} />
        <Text numberOfLines={1} style={[type.headline, { flex: 1, color: colors.label }]}>{name}</Text>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{overview.loaded ? `${projects.length} 个项目` : ""}</Text>
      </View>
      {overview.error ? (
        <Pressable accessibilityRole="button" onPress={() => { useComputers.getState().select(computer.key); router.push("/computer"); }} style={{ padding: 12 }}>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{overview.error} · 查看电脑</Text>
        </Pressable>
      ) : !overview.loaded ? <LoadingState label="正在读取项目…" /> : null}
      {overview.loaded && projects.length === 0 ? <Text style={[type.footnote, { color: colors.secondaryLabel, padding: 12 }]}>{query ? "没有匹配的项目" : "还没有项目"}</Text> : null}
      {wide ? <AdaptiveGrid minimum={360}>{projects.map((project) => <ProjectCard key={project.key} project={project} now={now} computerKey={computer.key} />)}</AdaptiveGrid> : projects.map((project, index) => <ProjectRow key={project.key} project={project} position={positionOf(index, projects.length)} now={now} computerKey={computer.key} />)}
      {overview.partial ? <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>显示最近活动，进入项目可加载更早的会话。</Text> : null}
    </View>
  );
}

export function ProjectsScreen() {
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const inlineControls = Platform.OS !== "ios" || !hasSideToolbar(systemInsets);
  const cardMinimum = 360;
  const wide = useContentWidth() >= cardMinimum * 2 + 48;
  const tabInset = useFloatingTabInset();
  const projects = useClient((state) => state.projects);
  const sessions = useClient((state) => state.sessions);
  const sessionsNextBefore = useClient((state) => state.sessionsNextBefore);
  const sessionsError = useClient((state) => state.sessionsError);
  const loaded = useClient((state) => state.sessionsLoaded);
  const status = useClient((state) => state.status);
  const displayStatus = useConnectionStatus();
  const offline = unreachable(displayStatus);
  const hasComputer = useHasComputer();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"current" | "all">("current");
  const focused = useIsFocused();
  const { computer: selected } = useConnection();
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const computers = useMemo(() => listComputers({ saved, live }), [saved, live]);
  const now = useNow();
  const currentOverview: ProjectOverview = status === "locked"
    ? { projects: [], sessions: [], loaded: false, partial: false, error: "请先输入这台电脑的访问密码" }
    : { projects, sessions: Object.values(sessions), loaded, partial: sessionsNextBefore !== undefined,
      error: displayStatus === "connecting" ? undefined : sessionsError ?? (offline ? "正在恢复连接；以下为上次读取的项目" : undefined) };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const grouped = groupProjects(projects, Object.values(sessions));
    return q ? grouped.filter((p) => `${p.name} ${p.cwd} ${p.paths.join(" ")}`.toLowerCase().includes(q)) : grouped;
  }, [projects, sessions, query]);

  return (
    <>
      <Stack.Screen options={{ title: "", headerShown: !inlineControls, headerTransparent: true, headerLargeTitleEnabled: false }} />
      <ScrollView
        contentInsetAdjustmentBehavior={!inlineControls && Platform.OS === "ios" ? "automatic" : "never"}
        keyboardDismissMode="on-drag"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: inlineControls ? Math.max(insets.top, systemInsets.top) + 8 : 16,
          paddingBottom: 32 + tabInset + (inlineControls && Platform.OS === "ios" ? Math.max(insets.bottom, systemInsets.bottom) : 0),
        }}
      >
        {!inlineControls ? <HeaderActions actions={[{ ...NEW_SESSION, kind: "button" }]} /> : null}
        <PageSearch value={query} onChangeText={setQuery} placeholder="搜索项目" action={inlineControls ? NEW_SESSION : undefined} />
        {computers.length > 1 ? <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: colors.fill, borderRadius: 12, padding: 3, marginTop: 12 }}>
          {([ ["current", "当前电脑"], ["all", "所有电脑"] ] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: scope === value }} onPress={() => setScope(value)} style={{ flex: 1, minHeight: 40, borderRadius: 9, justifyContent: "center", alignItems: "center", backgroundColor: scope === value ? colors.card : "transparent" }}><Text style={[type.subhead, { color: scope === value ? colors.label : colors.secondaryLabel }]}>{label}</Text></Pressable>)}
        </View> : null}
        {scope === "current" ? <ConnectionBanner /> : null}
        {!hasComputer ? (
          <Welcome />
        ) : scope === "all" ? (
          <View>{computers.map((computer) => <ComputerProjects key={computer.key} computer={computer} enabled={focused} query={query.trim().toLowerCase()} now={now} wide={wide} current={computer.key === selected.key ? currentOverview : undefined} />)}</View>
        ) : !loaded ? (
          offline ? <WaitingForComputer what="电脑上的项目" /> : <LoadingState label="正在读取项目…" />
        ) : shown.length === 0 ? (
          query ? (
            <EmptyState icon={{ sf: "magnifyingglass", md: "search" }} title={`没有匹配“${query}”的项目`} />
          ) : (
            <EmptyState
              icon={{ sf: "square.stack.3d.up", md: "stacks" }}
              title="还没有项目"
              message="在工作目录里开始会话后，可以在这里按项目查看进展。"
            />
          )
        ) : wide ? (
          <View style={{ marginTop: 12, gap: 12 }}>
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
              {query ? `${shown.length} 个匹配项目` : `${shown.length} 个项目 · 按最近活动排序`}
            </Text>
            <AdaptiveGrid minimum={cardMinimum}>
              {shown.map((project) => <ProjectCard key={project.key} project={project} now={now} computerKey={selected.key} />)}
            </AdaptiveGrid>
          </View>
        ) : (
          <View style={{ marginTop: 8 }}>
            {shown.map((project, index) => (
              <ProjectRow key={project.key} project={project} position={positionOf(index, shown.length)} now={now} computerKey={selected.key} />
            ))}
          </View>
        )}
      </ScrollView>
      {/* Without a native bar (iOS draws one only beside a side toolbar), content would run under the clock. */}
      {Platform.OS !== "ios" || inlineControls ? <StatusBarFade /> : null}
    </>
  );
}
