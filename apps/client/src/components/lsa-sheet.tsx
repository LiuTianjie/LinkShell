import type { LsaDecision, LsaFollowup, LsaMemory, LsaStatus, LsaTask } from "@linkshell/wire";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection, useClient } from "@/lib/client";
import { baseName } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";
import { Button } from "./button";
import { Text, TextInput } from "./fixed-text";
import { Icon } from "./icon";

export interface LsaSheetProps {
  visible: boolean;
  defaultCwd?: string;
  onClose: () => void;
}

type LsaTab = "tasks" | "followups" | "memories";

function statusTone(status: LsaTask["status"]) {
  if (status === "running" || status === "verifying" || status === "queued") return colors.running;
  if (status === "waiting_decision") return colors.waiting;
  if (status === "completed") return colors.ok;
  if (status === "failed") return colors.danger;
  return colors.tertiaryLabel;
}

export function LsaSheet({ visible, defaultCwd, onClose }: LsaSheetProps) {
  const { link } = useConnection();
  const online = useClient((s) => s.status === "online");
  const { t, pick } = useLocale();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<LsaTab>("tasks");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LsaStatus | null>(null);
  const [tasks, setTasks] = useState<LsaTask[]>([]);
  const [followups, setFollowups] = useState<LsaFollowup[]>([]);
  const [memories, setMemories] = useState<LsaMemory[]>([]);

  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [worktree, setWorktree] = useState(true);
  const [dispatching, setDispatching] = useState(false);

  const [steerTaskId, setSteerTaskId] = useState<string | null>(null);
  const [steerText, setSteerText] = useState("");
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (defaultCwd && !cwd) setCwd(defaultCwd);
  }, [defaultCwd, cwd]);

  const refresh = useCallback(async () => {
    if (!online) return;
    setLoading(true);
    setError(null);
    try {
      const [statusRes, tasksRes, followupsRes, memoriesRes] = await Promise.all([
        link.call("lsa.status", {}, 15_000),
        link.call("lsa.tasks", { limit: 30 }, 15_000),
        link.call("lsa.followups", { op: "list" }, 15_000),
        link.call("lsa.memories", { op: "list", limit: 25 }, 15_000),
      ]);
      setStatus(statusRes);
      setTasks(tasksRes.tasks);
      setFollowups(followupsRes.followups);
      setMemories(memoriesRes.memories);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [link, online]);

  useEffect(() => {
    if (visible && online) void refresh();
  }, [visible, online, refresh]);

  const onDispatch = async () => {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || dispatching) return;
    setDispatching(true);
    try {
      await link.call(
        "lsa.dispatch",
        {
          goal: trimmedGoal,
          cwd: cwd.trim() || undefined,
          worktree,
        },
        20_000,
      );
      haptics.success();
      setGoal("");
      await refresh();
    } catch (reason) {
      haptics.error();
      Alert.alert(
        pick({ zh: "派发失败", en: "Dispatch failed", ja: "委任に失敗しました" }),
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setDispatching(false);
    }
  };

  const onDecide = async (task: LsaTask, decision: LsaDecision, feedback?: string) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      await link.call(
        "lsa.decide",
        {
          taskId: task.id,
          decision,
          feedback: feedback?.trim() || undefined,
          controllerEpoch: task.controllerEpoch ?? status?.controllerEpoch,
        },
        15_000,
      );
      haptics.success();
      if (steerTaskId === task.id) {
        setSteerTaskId(null);
        setSteerText("");
      }
      await refresh();
    } catch (reason) {
      haptics.error();
      Alert.alert(
        pick({ zh: "操作失败", en: "Action failed", ja: "操作に失敗しました" }),
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setBusyTaskId(null);
    }
  };

  const onSteer = async (task: LsaTask) => {
    const instruction = steerText.trim();
    if (!instruction || busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      await link.call(
        "lsa.steer",
        {
          taskId: task.id,
          instruction,
          controllerEpoch: task.controllerEpoch ?? status?.controllerEpoch,
        },
        15_000,
      );
      haptics.success();
      setSteerTaskId(null);
      setSteerText("");
      await refresh();
    } catch (reason) {
      haptics.error();
      Alert.alert(
        pick({ zh: "发送指导失败", en: "Failed to steer task", ja: "指示の送信に失敗しました" }),
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setBusyTaskId(null);
    }
  };

  const onCompleteFollowup = async (id: string) => {
    try {
      await link.call("lsa.followups", { op: "complete", id }, 12_000);
      haptics.selection();
      await refresh();
    } catch {
      // Ignore transient errors; user can retry.
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.sheet, paddingTop: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingBottom: 10 }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={[type.title3, { color: colors.label }]}>{t("lsa.title")}</Text>
            <Text numberOfLines={2} style={[type.caption, { color: colors.secondaryLabel, marginTop: 2 }]}>
              {t("lsa.subtitle")}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              onPress={() => {
                haptics.selection();
                void refresh();
              }}
              accessibilityRole="button"
              accessibilityLabel={t("common.refresh")}
              hitSlop={8}
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
            >
              <Icon sf="arrow.clockwise" md="refresh" size={15} color={colors.secondaryLabel} weight="semibold" />
            </Pressable>
            <Pressable
              onPress={() => {
                haptics.selection();
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              hitSlop={8}
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
            >
              <Icon sf="xmark" md="close" size={14} color={colors.secondaryLabel} weight="bold" />
            </Pressable>
          </View>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 20) + 16, gap: 14 }}
        >
          {/* Status summary strip */}
          {status ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 8,
                padding: 12,
                borderRadius: radius.card,
                borderCurve: "continuous",
                backgroundColor: colors.sheetCard,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.separator,
              }}
            >
              <View style={{ flex: 1, minWidth: 90 }}>
                <Text style={[type.caption, { color: colors.secondaryLabel }]}>{t("lsa.activeTasks")}</Text>
                <Text style={[type.headline, { color: colors.label, marginTop: 2 }]}>{status.activeTasks}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 90 }}>
                <Text style={[type.caption, { color: colors.secondaryLabel }]}>{t("lsa.waitingDecision")}</Text>
                <Text style={[type.headline, { color: status.waitingDecisionTasks > 0 ? colors.waiting : colors.label, marginTop: 2 }]}>
                  {status.waitingDecisionTasks}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 90 }}>
                <Text style={[type.caption, { color: colors.secondaryLabel }]}>{t("lsa.followups")}</Text>
                <Text style={[type.headline, { color: colors.label, marginTop: 2 }]}>{status.dueFollowups}</Text>
              </View>
              {status.requiresYearlyTier && !status.enabled ? (
                <View style={{ width: "100%", paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator }}>
                  <Text style={[type.caption, { color: colors.secondaryLabel }]}>
                    {t("lsa.yearlyBadge")} ·{" "}
                    {pick({
                      zh: "可在电脑端 LinkShell 查看与管理总管权限。",
                      en: "Manage Steward access in LinkShell on your computer.",
                      ja: "PC 版 LinkShell でスチュワード権限を管理できます。",
                    })}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Dispatch card */}
          <View
            style={{
              gap: 10,
              padding: 14,
              borderRadius: radius.card,
              borderCurve: "continuous",
              backgroundColor: colors.sheetCard,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.separator,
            }}
          >
            <TextInput
              value={goal}
              onChangeText={setGoal}
              placeholder={t("lsa.dispatchPlaceholder")}
              placeholderTextColor={colors.placeholder as string}
              multiline
              style={[
                type.subhead,
                {
                  minHeight: 68,
                  color: colors.label,
                  textAlignVertical: "top",
                },
              ]}
            />
            {status?.candidates && status.candidates.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {status.candidates.slice(0, 6).map((cand) => {
                  const selected = cwd === cand.cwd;
                  return (
                    <Pressable
                      key={cand.cwd}
                      onPress={() => {
                        haptics.selection();
                        setCwd(cand.cwd);
                      }}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: radius.chip,
                        backgroundColor: selected ? colors.accentSoft : colors.fill,
                      }}
                    >
                      <Text style={[type.caption, { color: selected ? colors.accent : colors.secondaryLabel, fontFamily: mono }]}>
                        {cand.name || baseName(cand.cwd)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
                <Switch value={worktree} onValueChange={setWorktree} />
                <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                  {cwd ? `${t("nav.worktrees")} · ${baseName(cwd)}` : t("nav.worktrees")}
                </Text>
              </View>
              <Button
                title={t("lsa.dispatchAction")}
                size="small"
                busy={dispatching}
                disabled={!online || !goal.trim() || dispatching}
                onPress={() => void onDispatch()}
              />
            </View>
          </View>

          {/* Sub-navigation tabs */}
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(
              [
                { key: "tasks", label: `${t("lsa.activeTasks")} (${tasks.length})` },
                { key: "followups", label: `${t("lsa.followups")} (${followups.length})` },
                { key: "memories", label: `${t("lsa.memories")} (${memories.length})` },
              ] as const
            ).map((item) => {
              const selected = tab === item.key;
              return (
                <Pressable
                  key={item.key}
                  onPress={() => {
                    haptics.selection();
                    setTab(item.key);
                  }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: selected ? colors.accentFill : colors.fill,
                  }}
                >
                  <Text style={[type.footnote, { color: selected ? colors.onAccent : colors.label, fontWeight: "600" }]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {loading && !status ? <ActivityIndicator style={{ marginVertical: 20 }} color={colors.secondaryLabel} /> : null}
          {error ? <Text style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}

          {tab === "tasks" ? (
            tasks.length === 0 ? (
              <View style={{ alignItems: "center", paddingVertical: 28, gap: 6 }}>
                <Icon sf="checklist" md="checklist" size={26} color={colors.tertiaryLabel} />
                <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{t("lsa.emptyTasks")}</Text>
              </View>
            ) : (
              tasks.map((task) => {
                const steering = steerTaskId === task.id;
                const busy = busyTaskId === task.id;
                return (
                  <View
                    key={task.id}
                    style={{
                      gap: 8,
                      padding: 14,
                      borderRadius: radius.card,
                      borderCurve: "continuous",
                      backgroundColor: colors.sheetCard,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: colors.separator,
                    }}
                  >
                    <Pressable
                      disabled={!task.sessionId}
                      onPress={() => {
                        if (!task.sessionId) return;
                        haptics.selection();
                        onClose();
                        router.push({ pathname: "/session/[id]", params: { id: task.sessionId } });
                      }}
                      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                    >
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusTone(task.status) }} />
                      <Text numberOfLines={2} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
                        {task.title || task.goal}
                      </Text>
                      {task.sessionId ? <Icon sf="chevron.right" md="chevron_right" size={14} color={colors.tertiaryLabel} /> : null}
                    </Pressable>

                    {task.title ? (
                      <Text numberOfLines={3} style={[type.footnote, { color: colors.secondaryLabel }]}>
                        {task.goal}
                      </Text>
                    ) : null}

                    {task.summary ? (
                      <Text numberOfLines={3} style={[type.caption, { color: colors.secondaryLabel }]}>
                        {task.summary}
                      </Text>
                    ) : null}

                    <Text numberOfLines={1} style={[type.caption, { color: colors.tertiaryLabel, fontFamily: mono }]}>
                      {baseName(task.cwd)} · {task.status}
                    </Text>

                    {steering ? (
                      <View style={{ gap: 8, marginTop: 4 }}>
                        <TextInput
                          value={steerText}
                          onChangeText={setSteerText}
                          placeholder={t("lsa.steerPlaceholder")}
                          placeholderTextColor={colors.placeholder as string}
                          style={[
                            type.footnote,
                            {
                              paddingHorizontal: 10,
                              paddingVertical: 8,
                              borderRadius: radius.control,
                              backgroundColor: colors.fill,
                              color: colors.label,
                            },
                          ]}
                        />
                        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                          <Button title={t("common.cancel")} variant="plain" size="small" onPress={() => setSteerTaskId(null)} />
                          {task.status === "waiting_decision" ? (
                            <Button
                              title={t("lsa.retry")}
                              variant="tonal"
                              size="small"
                              busy={busy}
                              disabled={!steerText.trim() || busy}
                              onPress={() => void onDecide(task, "retry", steerText)}
                            />
                          ) : (
                            <Button
                              title={t("composer.send")}
                              size="small"
                              busy={busy}
                              disabled={!steerText.trim() || busy}
                              onPress={() => void onSteer(task)}
                            />
                          )}
                        </View>
                      </View>
                    ) : null}

                    {task.status === "waiting_decision" || task.status === "running" || task.status === "verifying" || task.status === "queued" ? (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
                        {task.status === "waiting_decision" ? (
                          <Button
                            title={t("lsa.accept")}
                            size="small"
                            busy={busy}
                            disabled={busy}
                            onPress={() => void onDecide(task, "accept")}
                          />
                        ) : null}
                        <Button
                          title={task.status === "waiting_decision" ? t("lsa.retry") : t("lsa.steerPlaceholder").replace(/…$/, "")}
                          variant="tonal"
                          size="small"
                          disabled={busy}
                          onPress={() => {
                            haptics.selection();
                            setSteerTaskId(steering ? null : task.id);
                          }}
                        />
                        <Button
                          title={t("lsa.cancel")}
                          variant="plain"
                          size="small"
                          disabled={busy}
                          onPress={() => void onDecide(task, "cancel")}
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })
            )
          ) : tab === "followups" ? (
            followups.length === 0 ? (
              <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center", paddingVertical: 24 }]}>
                {pick({ zh: "暂无待办跟进项", en: "No pending follow-ups", ja: "保留中のリマインダーはありません" })}
              </Text>
            ) : (
              followups.map((item) => (
                <View
                  key={item.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    padding: 12,
                    borderRadius: radius.card,
                    backgroundColor: colors.sheetCard,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.separator,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[type.subhead, { color: colors.label }]}>{item.note}</Text>
                    <Text style={[type.caption, { color: colors.tertiaryLabel }]}>
                      {new Date(item.dueAt).toLocaleString()}
                    </Text>
                  </View>
                  {!item.done ? (
                    <Button title={t("common.confirm")} variant="tonal" size="small" onPress={() => void onCompleteFollowup(item.id)} />
                  ) : null}
                </View>
              ))
            )
          ) : memories.length === 0 ? (
            <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center", paddingVertical: 24 }]}>
              {pick({ zh: "暂无长期记忆条目", en: "No saved memories yet", ja: "保存されたメモリはまだありません" })}
            </Text>
          ) : (
            memories.map((mem) => (
              <View
                key={`${mem.scope ?? "global"}:${mem.key}`}
                style={{
                  gap: 4,
                  padding: 12,
                  borderRadius: radius.card,
                  backgroundColor: colors.sheetCard,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.separator,
                }}
              >
                <Text style={[type.footnote, { color: colors.label, fontWeight: "600", fontFamily: mono }]}>{mem.key}</Text>
                <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{mem.content}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
