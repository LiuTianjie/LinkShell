import type { AgentInfo } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import Storage from "expo-sqlite/kv-store";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentTile } from "@/components/agent-tile";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { openSession } from "@/components/session-row";
import { useActions, useClient, useConnection } from "@/lib/client";
import { baseName, shortPath } from "@/lib/format";
import { openTerminal, TerminalTile } from "@/components/terminal-row";
import { AppMenu } from "@/components/app-menu";
import { onDirectoryPicked } from "@/lib/directory-pick";
import { haptics } from "@/lib/haptics";
import { BranchTag } from "@/components/branch-tag";
import { branchLabel, branchOf, useGitInfo } from "@/lib/worktree";
import { agentLook, tierCopy } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const LAST_AGENT_KEY = "new.agent";
/** The "agent" choice that opens a plain terminal instead. */
const TERMINAL = "terminal";

/** One choice in the "用什么" row: an agent, or the terminal. */
function ChoiceCard({
  selected,
  disabled = false,
  label,
  note,
  onPress,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  label: string;
  note?: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      style={{
        width: 78,
        alignItems: "center",
        gap: 7,
        paddingVertical: 11,
        borderRadius: 18,
        borderCurve: "continuous",
        backgroundColor: selected ? colors.accentSoft : colors.sheetCard,
        borderWidth: 1.5,
        borderColor: selected ? colors.accent : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
      <Text numberOfLines={1} style={[type.footnote, { color: colors.label, fontWeight: selected ? "700" : "500" }]}>
        {label}
      </Text>
      {note ? <Text style={[type.caption2, { color: colors.waiting }]}>{note}</Text> : null}
    </Pressable>
  );
}
const OTHER = "\u0000other";

function lastAgent(): string | null {
  try {
    return Storage.getItemSync(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

function usable(agent: AgentInfo): boolean {
  return agent.installed && agent.auth?.state !== "missing" && agent.tier !== "terminal";
}

function Label({ children }: { children: string }) {
  return <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 4 }]}>{children}</Text>;
}

export function NewSessionScreen() {
  const params = useLocalSearchParams<{ cwd?: string }>();
  const machine = useClient((state) => state.machine);
  const projects = useClient((state) => state.projects);
  const online = useClient((state) => state.status === "online");
  const { createSession, send } = useActions();
  const insets = useSafeAreaInsets();

  const agents = useMemo(() => (machine?.agents ?? []).filter((agent) => agent.installed && agent.tier !== "terminal"), [machine]);
  const [agentId, setAgentId] = useState<string | null>(() => {
    const remembered = lastAgent();
    if (remembered === TERMINAL) return TERMINAL;
    const pick = agents.find((a) => a.id === remembered && usable(a)) ?? agents.find(usable);
    return pick?.id ?? null;
  });
  const terminal = agentId === TERMINAL;
  const selectedAgent = terminal ? undefined : (agents.find((agent) => agent.id === agentId) ?? agents.find(usable));
  const { link } = useConnection();

  // A directory picked in the browser joins the list, selected.
  const [picked, setPicked] = useState<string | undefined>(params.cwd);
  const recent = useMemo(() => {
    const list = projects.slice(0, 6);
    if (picked && !list.some((p) => p.cwd === picked)) {
      list.unshift({ cwd: picked, name: baseName(picked), lastActiveAt: 0, sessionCount: 0 });
    }
    return list;
  }, [projects, picked]);
  const [cwd, setCwd] = useState<string>(() => params.cwd ?? projects[0]?.cwd ?? "");
  useEffect(
    () =>
      onDirectoryPicked((path) => {
        setPicked(path);
        setCwd(path);
      }),
    [],
  );
  // A git repository can give the session a worktree of its own. Off each time; nothing is remembered.
  const git = useGitInfo(cwd || undefined);
  const branch = branchOf(git);
  const [worktree, setWorktree] = useState(false);
  useEffect(() => setWorktree(false), [cwd]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetCwd = cwd;
  const ready = online && (terminal || (!!selectedAgent && usable(selectedAgent))) && targetCwd.length > 0 && !busy;

  const remember = (id: string) => {
    try {
      Storage.setItemSync(LAST_AGENT_KEY, id);
    } catch {
      // Remembering the choice is only a convenience.
    }
  };

  const start = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    haptics.medium();
    if (terminal) {
      try {
        const { terminal: created } = await link.call("terminals.create", { cwd: targetCwd, command: prompt.trim() || undefined });
        remember(TERMINAL);
        router.dismiss();
        openTerminal(created.id);
      } catch (reason) {
        haptics.error();
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(false);
      }
      return;
    }
    if (!selectedAgent) return;
    try {
      const session = await createSession({ agent: selectedAgent.id, cwd: targetCwd, worktree: (worktree && !!git) || undefined });
      remember(selectedAgent.id);
      router.dismiss();
      openSession(session.id);
      const text = prompt.trim();
      if (text) void send(session.id, [{ type: "text", text }]);
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 22, paddingBottom: 6 }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>新会话</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={10}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="xmark" md="close" size={13} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </View>

      {/* Wrapped: a sheet stretches a scroll view that's a direct child of the screen over the whole sheet. */}
      <View style={{ flex: 1, overflow: "hidden" }}>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 22 }}
      >
        <View style={{ gap: 10 }}>
          <Label>用什么</Label>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            // Runs to the sheet's edges so the row visibly continues.
            style={{ marginHorizontal: -16 }}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16, alignItems: "center" }}
          >
            <ChoiceCard selected={terminal} label="终端" onPress={() => setAgentId(TERMINAL)}>
              <TerminalTile size={36} />
            </ChoiceCard>
            <View style={{ width: StyleSheet.hairlineWidth * 2, height: 48, backgroundColor: colors.separator, marginHorizontal: 2 }} />
            {agents.map((agent) => {
              const selected = !terminal && agent.id === selectedAgent?.id;
              const ok = usable(agent);
              return (
                <ChoiceCard
                  key={agent.id}
                  selected={selected}
                  disabled={!ok}
                  label={agentLook(agent.id, agent.label).short}
                  note={ok ? undefined : "未登录"}
                  onPress={() => setAgentId(agent.id)}
                >
                  <AgentTile agent={agent.id} size={36} />
                </ChoiceCard>
              );
            })}
          </ScrollView>
          {terminal ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>在这台电脑上运行任何命令 · 断开后也会继续运行</Text>
          ) : agents.length === 0 ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
              {online ? "这台电脑上还没有可用的 Agent" : "连上电脑后才能新建会话"}
            </Text>
          ) : null}
          {!terminal && selectedAgent ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
              {tierCopy[selectedAgent.tier].label} · {tierCopy[selectedAgent.tier].line}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: 10 }}>
          <Label>项目</Label>
          <AppMenu
            title="在哪个目录里运行"
            shouldOpenOnLongPress={false}
            onOpenMenu={() => haptics.selection()}
            actions={[
              ...recent.map((project) => ({
                id: project.cwd,
                title: project.name,
                subtitle: shortPath(project.cwd),
                state: project.cwd === cwd ? ("on" as const) : ("off" as const),
              })),
              { id: OTHER, title: "浏览电脑上的目录…", image: "folder.badge.plus" },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === OTHER) router.push("/browse");
              else setCwd(nativeEvent.event);
            }}
          >
            <View
              accessibilityRole="button"
              accessibilityLabel={`项目：${cwd ? baseName(cwd) : "未选择"}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: colors.sheetCard,
              }}
            >
              <Icon sf="folder.fill" md="folder" size={20} color={colors.accent} />
              <View style={{ flex: 1, gap: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text numberOfLines={1} style={[type.body, { flexShrink: 1, fontSize: 16, color: cwd ? colors.label : colors.tertiaryLabel, fontWeight: "600" }]}>
                    {cwd ? baseName(cwd) : "选择项目"}
                  </Text>
                  {branch ? <BranchTag branch={branch} size={13} max={20} /> : null}
                </View>
                {cwd ? (
                  <Text numberOfLines={1} style={[type.caption, { color: colors.tertiaryLabel }]}>
                    {shortPath(cwd)}
                  </Text>
                ) : null}
              </View>
              <Icon sf="chevron.up.chevron.down" md="unfold_more" size={13} color={colors.tertiaryLabel} weight="semibold" />
            </View>
          </AppMenu>
          {git && !terminal ? (
            <Pressable
              onPress={() => {
                haptics.selection();
                setWorktree((value) => !value);
              }}
              accessibilityRole="switch"
              accessibilityState={{ checked: worktree }}
              accessibilityLabel="在新的 worktree 里开始"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: colors.sheetCard,
              }}
            >
              <Icon sf="arrow.triangle.branch" md="fork_right" size={18} color={worktree ? colors.accent : colors.secondaryLabel} />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>在新的 worktree 里开始</Text>
                <Text style={[type.caption, { color: colors.secondaryLabel }]}>
                  {branch ? `从 ${branchLabel(branch, 24)} 分出独立的目录和分支` : "独立的目录和分支，不影响当前工作区"}
                  {git.dirty ? "；未提交的改动不会带过去" : ""}
                </Text>
              </View>
              <View pointerEvents="none">
                <Switch value={worktree} trackColor={{ true: colors.accent as string }} />
              </View>
            </Pressable>
          ) : null}
        </View>

        <View style={{ gap: 10 }}>
          <Label>{terminal ? "启动命令（可选）" : "要做什么（可选）"}</Label>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline={!terminal}
            autoCapitalize={terminal ? "none" : "sentences"}
            // A command is ASCII: no input method in the way.
            keyboardType={terminal ? (Platform.OS === "android" ? "visible-password" : "ascii-capable") : "default"}
            autoCorrect={!terminal}
            spellCheck={!terminal}
            returnKeyType={terminal ? "go" : "default"}
            onSubmitEditing={terminal ? () => void start() : undefined}
            placeholder={terminal ? "例如 npm run dev，不填就打开一个空终端" : `告诉 ${selectedAgent ? agentLook(selectedAgent.id).short : "Agent"} 你想做什么`}
            placeholderTextColor={colors.placeholder as string}
            style={[
              type.callout,
              terminal ? { fontFamily: mono, fontSize: 15 } : null,
              {
                minHeight: terminal ? 50 : 96,
                maxHeight: 200,
                color: colors.label,
                backgroundColor: colors.sheetCard,
                borderRadius: 18,
                borderCurve: "continuous",
                paddingHorizontal: 14,
                paddingTop: 12,
                paddingBottom: 12,
                textAlignVertical: "top",
              },
            ]}
          />
        </View>

        {error ? (
          <Text selectable style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>
            {error}
          </Text>
        ) : null}
        <Button title={terminal ? "打开终端" : "开始"} variant="primary" size="large" wide busy={busy} disabled={!ready} onPress={() => void start()} />
      </KeyboardAwareScrollView>
      </View>
    </View>
  );
}
