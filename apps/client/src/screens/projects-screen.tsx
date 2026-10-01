import type { ProjectSummary } from "@linkshell/wire";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
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
import { PageHeader, PageSearch, StatusBarFade } from "@/components/page-header";

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
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 32 + tabInset,
        }}
      >
        <PageHeader title="项目" actions={[NEW_SESSION]}>
          <PageSearch value={query} onChangeText={setQuery} placeholder="搜索项目" />
        </PageHeader>
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
        ) : (
          <View style={{ marginTop: 8 }}>
            {shown.map((project, index) => (
              <ProjectRow key={project.cwd} project={project} position={positionOf(index, shown.length)} now={now} />
            ))}
          </View>
        )}
      </ScrollView>
      <StatusBarFade />
    </>
  );
}
