import { workflowIsLive, type WorkflowRecords } from "@linkshell/client-core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { AdaptiveGrid, usePageInsets } from "@/components/adaptive-page";
import { ScrollableState } from "@/components/scrollable-state";
import { EmptyState, LoadingState } from "@/components/state-views";
import { WorkflowCardContent, WorkflowPhaseSection, WorkflowSummary } from "@/components/workflow";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
import { workflowGroups } from "@/lib/workflows";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const gallery: WorkflowRecords = __DEV__ ? require("@/dev/workflow-fixtures").galleryWorkflows : {};

function useWorkflows(sessionId: string) {
  const demo = sessionId === "gallery";
  const { loadSubagents } = useActions();
  const records = useClient((state) => state.workflows[sessionId]);
  const ready = useClient((state) => !!state.ready[sessionId]);
  const online = useClient((state) => state.status === "online");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  useSessionSubscription(sessionId, !demo);
  const reload = useCallback(() => {
    setError(undefined);
    return loadSubagents(sessionId).then(() => setLoaded(true)).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [loadSubagents, sessionId]);
  useEffect(() => {
    if (!demo && ready && online) void reload();
  }, [demo, ready, online, reload]);
  return { records: demo ? gallery : records, loaded: demo || loaded, error, online, reload };
}

export function WorkflowScreen() {
  const { id, call } = useLocalSearchParams<{ id: string; call: string }>();
  const insets = usePageInsets();
  const { records, loaded, error, online, reload } = useWorkflows(id);
  const record = records?.[call];
  const [taskOpen, setTaskOpen] = useState(false);
  const groups = useMemo(() => record ? workflowGroups(record.workflow) : [], [record]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: "工作流", headerShown: true, headerTransparent: false, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background as string } }} />
      {!record ? (
        <ScrollableState><WorkflowMissing loaded={loaded} error={error} online={online} reload={reload} /></ScrollableState>
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingBottom: 24 + (Platform.OS === "ios" ? 0 : insets.bottom), gap: 20 }}>
          <WorkflowSummary record={record} />
          {record.task && record.task !== record.workflow.name ? (
            <Pressable onPress={() => setTaskOpen((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: taskOpen }} accessibilityLabel="工作流任务说明" style={{ minHeight: 44, justifyContent: "center" }}>
              <Text numberOfLines={taskOpen ? undefined : 3} selectable={taskOpen} style={[type.subhead, { color: colors.secondaryLabel }]}>{record.task}</Text>
            </Pressable>
          ) : null}
          <View style={{ height: 0.5, backgroundColor: colors.separator }} />
          {groups.length ? groups.map((group) => <WorkflowPhaseSection key={group.id} group={group} sessionId={id} />) : (
            <EmptyState icon={{ sf: "point.3.connected.trianglepath.dotted", md: "account_tree" }} title={workflowIsLive(record.workflow) ? "等待 Agent 加入" : "没有 Agent 过程记录"} message={workflowIsLive(record.workflow) ? "流程推进时，Agent 和阶段会显示在这里。" : "当前运行没有提供可查看的 Agent 记录。"} />
          )}
          {workflowIsLive(record.workflow) && groups.length > 0 ? <Text style={[type.caption, { color: colors.tertiaryLabel }]}>Agent 会随流程推进继续加入。</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

export function WorkflowsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = usePageInsets();
  const { records, loaded, error, online, reload } = useWorkflows(id);
  const runs = useMemo(() => Object.values(records ?? {}).sort((a, b) => Number(workflowIsLive(b.workflow)) - Number(workflowIsLive(a.workflow)) || b.startedAt - a.startedAt), [records]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.plain }}>
      <Stack.Screen options={{ title: "工作流", headerShown: true, headerTransparent: false, headerShadowVisible: false }} />
      {!runs.length ? <ScrollableState><WorkflowMissing loaded={loaded} error={error} online={online} reload={reload} /></ScrollableState> : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 16, paddingBottom: 24 + (Platform.OS === "ios" ? 0 : insets.bottom), gap: 14 }}>
          <AdaptiveGrid>{runs.map((record) => <WorkflowCardContent key={record.toolCallId} record={record} sessionId={id} />)}</AdaptiveGrid>
        </ScrollView>
      )}
    </View>
  );
}

function WorkflowMissing({ loaded, error, online, reload }: { loaded: boolean; error?: string; online: boolean; reload: () => Promise<unknown> }) {
  if (error) return <EmptyState icon={{ sf: "exclamationmark.triangle", md: "warning" }} title="读取失败" message={error} action={{ title: "重试", onPress: () => void reload() }} />;
  if (!online && !loaded) return <EmptyState icon={{ sf: "laptopcomputer", md: "laptop_mac" }} title="等电脑连上" message="连接后会继续载入工作流。" />;
  if (!loaded) return <LoadingState label="正在读取工作流…" />;
  return <EmptyState icon={{ sf: "point.3.connected.trianglepath.dotted", md: "account_tree" }} title="没有工作流记录" message="Claude 启动 Workflow 后，会列在这里。" />;
}
