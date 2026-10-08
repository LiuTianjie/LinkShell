import type { ProjectSummary } from "@linkshell/wire";
import { router, Stack } from "expo-router";
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
import { useClient, useHasComputer } from "@/lib/client";
import { Welcome } from "@/components/welcome";
import { relativeTime, shortPath } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { NEW_SESSION } from "@/components/new-session-action";
import { PageSearch, StatusBarFade } from "@/components/page-header";
import { type } from "@/theme/type";

function ProjectCard({ project, now }: { project: ProjectSummary; now: number }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/projects/detail", params: { cwd: project.cwd } })}
      accessibilityRole="button"
      accessibilityLabel={`${project.name}，${project.sessionCount} 个会话`}
      style={({ pressed }) => ({
        padding: 20, gap: 18, minHeight: 188, borderRadius: 24, borderCurve: "continuous",
        backgroundColor: pressed ? colors.fill : colors.card,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon sf="folder.fill" md="folder" size={24} color={colors.accent} />
        </View>
        <Text style={[type.footnote, { flex: 1, textAlign: "right", color: colors.secondaryLabel }]}>{relativeTime(project.lastActiveAt, now)}</Text>
        <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} />
      </View>
      <View style={{ gap: 5 }}>
        <Text numberOfLines={2} style={[type.title3, { color: colors.label }]}>{project.name}</Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={[type.footnote, { color: colors.secondaryLabel }]}>{shortPath(project.cwd)}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: "auto" }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{project.sessionCount} 个会话</Text>
        {project.branch ? <BranchTag branch={project.branch} size={13} max={24} /> : null}
      </View>
    </Pressable>
  );
}

function ProjectRow({ project, position, now }: { project: ProjectSummary; position: RowPosition; now: number }) {
  return (
    <ListRow
      leading={<Icon sf="folder.fill" md="folder" size={20} color={colors.accent} />}
      title={project.name}
      titleTag={project.branch ? <BranchTag branch={project.branch} size={13} max={20} /> : undefined}
      time={relativeTime(project.lastActiveAt, now)}
      detail={`${shortPath(project.cwd)} · ${project.sessionCount} 个会话`}
      position={position}
      onPress={() => router.push({ pathname: "/projects/detail", params: { cwd: project.cwd } })}
      accessibilityLabel={`${project.name}，${project.sessionCount} 个会话`}
    />
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
  const loaded = useClient((state) => state.sessionsLoaded);
  const offline = useClient((state) => unreachable(state.status));
  const hasComputer = useHasComputer();
  const [query, setQuery] = useState("");
  const now = useNow();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

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
        <ConnectionBanner />
        {!hasComputer ? (
          <Welcome />
        ) : !loaded ? (
          offline ? <WaitingForComputer what="电脑上的项目" /> : <LoadingState label="正在读取项目…" />
        ) : shown.length === 0 ? (
          query ? (
            <EmptyState icon={{ sf: "magnifyingglass", md: "search" }} title={`没有匹配“${query}”的项目`} />
          ) : (
            <EmptyState
              icon={{ sf: "folder", md: "folder" }}
              title="还没有项目"
              message="在电脑上任意目录里用 Agent 开过会话，这里就会出现那个目录。"
            />
          )
        ) : wide ? (
          <View style={{ marginTop: 12, gap: 12 }}>
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
              {query ? `${shown.length} 个匹配项目` : `${shown.length} 个项目 · 按最近活动排序`}
            </Text>
            <AdaptiveGrid minimum={cardMinimum}>
              {shown.map((project) => <ProjectCard key={project.cwd} project={project} now={now} />)}
            </AdaptiveGrid>
          </View>
        ) : (
          <View style={{ marginTop: 8 }}>
            {shown.map((project, index) => (
              <ProjectRow key={project.cwd} project={project} position={positionOf(index, shown.length)} now={now} />
            ))}
          </View>
        )}
      </ScrollView>
      {Platform.OS !== "ios" ? <StatusBarFade /> : null}
    </>
  );
}
