import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { MenuView } from "@react-native-menu/menu";

import { AppSymbol } from "../../../components/AppSymbol";
import type { Theme } from "../../../theme";
import { useComposerDictation } from "../../../hooks/useComposerDictation";
import {
  DEFAULT_OPTION_ID,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_DATA_URL_LENGTH,
  formatEffort,
  formatModel,
} from "../lib/format";
import {
  effortOptionsFor,
  modelOptionsFor,
  permissionOptionsFor,
  providerCapabilityFor,
} from "../lib/capabilities";
import {
  commandFromMessage,
  commandRawText,
  trailingMentionToken,
  trailingSlashCommandToken,
} from "../lib/commands";
import { imageBlockFromAsset } from "../lib/timeline";
import type {
  AgentCapabilities,
  AgentCollaborationMode,
  AgentCommandDescriptor,
  AgentContentBlock,
  AgentConversationRecord,
  AgentFileEntry,
  AgentNotice,
  AgentPermissionMode,
  AgentReasoningEffort,
  AgentTimelineItem,
  AgentWorkspaceHandle,
} from "../types";
import { NoticeStrip } from "./message-cards";
import { MentionPanel, QueuedFollowUpList, SlashCommandPanel } from "./panels";

/**
 * Imperative surface the screen drives:
 * - `setDraft` mirrors the timeline's "edit message" action (sets the draft,
 *   moves the caret to the end, focuses the input, and gives a selection tick).
 * - `focus` focuses the composer input.
 * - `openRename` opens the rename flow (native prompt on iOS, modal elsewhere).
 */
export interface ComposerHandle {
  setDraft: (text: string) => void;
  focus: () => void;
  openRename: () => void;
}

export interface ComposerProps {
  conversation: AgentConversationRecord;
  capabilities: AgentCapabilities | undefined;
  workspace: AgentWorkspaceHandle;
  theme: Theme;
  /** Notices already filtered to this conversation by the screen. */
  notices: AgentNotice[];
  /** Queued follow-up user messages (derived from the deduped timeline). */
  queuedFollowUps: AgentTimelineItem[];
  /** True once a planning turn has finished and is ready to execute. */
  planReady: boolean;
  /** Safe-area bottom inset, used for the composer's bottom padding. */
  bottomInset: number;
  /** Keyboard-driven offset for the absolutely positioned composer wrapper. */
  bottomOffset: number;
  /** Reports the measured composer height back to the screen (for list inset). */
  onHeightChange: (height: number) => void;
  /** Invoked after a send/execute/steer so the screen can stick to the bottom. */
  onAfterSend: () => void;
}

function valueFromMenuId<T extends string>(id: string): T | undefined {
  return id === DEFAULT_OPTION_ID ? undefined : (id as T);
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    conversation,
    capabilities,
    workspace,
    theme,
    notices,
    queuedFollowUps,
    planReady,
    bottomInset,
    bottomOffset,
    onHeightChange,
    onAfterSend,
  },
  ref,
) {
  const composerInputRef = useRef<TextInput>(null);
  // Cursor position in the composer, so dictated text inserts where the caret
  // is rather than always appending. Updated on every selection change.
  const selectionRef = useRef(0);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(conversation.model);
  const [effort, setEffort] = useState<AgentReasoningEffort | undefined>(conversation.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | undefined>(
    conversation.permissionMode,
  );
  const [attachments, setAttachments] = useState<AgentContentBlock[]>([]);
  // Android rename modal (iOS uses the native Alert.prompt instead).
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // @-file-mention palette state: entries fetched for the directory under the
  // current @token, refetched only when that directory changes.
  const [mentionEntries, setMentionEntries] = useState<AgentFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState<string | undefined>();
  const [mentionFetchedDir, setMentionFetchedDir] = useState<string | null>(null);

  const providerCapability = providerCapabilityFor(conversation.provider, capabilities);
  const providerSupportsImageInput = conversation.provider === "claude" || conversation.provider === "codex";
  const supportsImages = Boolean(
    providerSupportsImageInput ||
      (capabilities?.enabled && (providerCapability?.supportsImages ?? capabilities.supportsImages)),
  );
  const turnRunning = conversation.status === "running";
  const waitingPermission = conversation.status === "waiting_permission";
  const running = turnRunning || waitingPermission;
  const canSteerRunningTurn = turnRunning && conversation.provider === "codex";
  const canSend = Boolean(text.trim() || attachments.length > 0);

  const modelOpts = useMemo(
    () => modelOptionsFor(conversation.provider, capabilities),
    [capabilities, conversation.provider],
  );
  const effortOpts = useMemo(
    () => effortOptionsFor(conversation.provider, capabilities),
    [capabilities, conversation.provider],
  );
  const permissionOpts = useMemo(
    () => permissionOptionsFor(conversation.provider, capabilities),
    [capabilities, conversation.provider],
  );

  const commandToken = useMemo(() => trailingSlashCommandToken(text), [text]);
  const availableCommands = useMemo(
    () =>
      (providerCapability?.commands ?? []).filter(
        (command) => !command.provider || command.provider === conversation.provider,
      ),
    [conversation.provider, providerCapability?.commands],
  );
  const commandPanelVisible = Boolean(
    commandToken && availableCommands.length > 0 && attachments.length === 0 && !running,
  );
  // @-file-mention: active when a trailing @token exists and the slash palette
  // isn't (slash takes priority). Resolves the absolute dir to browse from cwd.
  const mentionToken = useMemo(
    () => (commandToken ? null : trailingMentionToken(text)),
    [commandToken, text],
  );
  const mentionTargetDir = useMemo(() => {
    if (!mentionToken) return null;
    const base = (conversation.cwd || ".").replace(/\/+$/, "") || "/";
    return mentionToken.dir ? `${base}/${mentionToken.dir}` : base;
  }, [conversation.cwd, mentionToken]);
  const mentionPanelVisible = Boolean(mentionToken && !running);
  const currentCollaborationMode = (conversation.collaborationMode ??
    providerCapability?.currentMode ??
    "default") as AgentCollaborationMode;

  useEffect(() => {
    setModel(conversation.model);
    setEffort(conversation.reasoningEffort);
    setPermissionMode(conversation.permissionMode);
  }, [conversation.id, conversation.model, conversation.permissionMode, conversation.reasoningEffort]);

  // Fetch directory entries for the active @-mention token. Guarded against
  // races (only the latest target's result is applied) and only refetches when
  // the resolved directory changes, not on every keystroke within it.
  useEffect(() => {
    if (!mentionTargetDir) {
      setMentionLoading(false);
      return;
    }
    if (mentionTargetDir === mentionFetchedDir) return;
    let cancelled = false;
    setMentionLoading(true);
    setMentionError(undefined);
    workspace
      .browseFiles(conversation.id, mentionTargetDir)
      .then((result) => {
        if (cancelled) return;
        setMentionEntries(result.error ? [] : result.entries);
        setMentionError(result.error);
        setMentionFetchedDir(mentionTargetDir);
      })
      .catch(() => {
        if (!cancelled) setMentionError("读取目录失败。");
      })
      .finally(() => {
        if (!cancelled) setMentionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id, mentionFetchedDir, mentionTargetDir, workspace]);

  useEffect(() => {
    if (effort && !effortOpts.some((option) => option.value === effort)) {
      setEffort(undefined);
      workspace.updateConversationSettings(conversation.id, { reasoningEffort: undefined }).catch(() => {});
    }
  }, [conversation.id, effort, effortOpts, workspace]);

  useEffect(() => {
    if (permissionMode && !permissionOpts.some((option) => option.value === permissionMode)) {
      setPermissionMode(undefined);
      workspace.updateConversationSettings(conversation.id, { permissionMode: undefined }).catch(() => {});
    }
  }, [conversation.id, permissionMode, permissionOpts, workspace]);

  const modelMenuActions = useMemo(
    () =>
      modelOpts.map((option) => ({
        id: `model:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: "square.stack.3d.up",
        state: option.value === model ? ("on" as const) : ("off" as const),
      })),
    [modelOpts, model],
  );
  const effortMenuActions = useMemo(
    () =>
      effortOpts.map((option) => ({
        id: `effort:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: "textformat.size.larger",
        state: option.value === effort ? ("on" as const) : ("off" as const),
      })),
    [effortOpts, effort],
  );
  const permissionMenuActions = useMemo(
    () =>
      permissionOpts.map((option) => ({
        id: `permission:${option.value ?? DEFAULT_OPTION_ID}`,
        title: option.label,
        image: option.image,
        state: option.value === permissionMode ? ("on" as const) : ("off" as const),
      })),
    [permissionOpts, permissionMode],
  );

  const commitModel = useCallback(
    (nextModel: string | undefined) => {
      setModel(nextModel);
      workspace.updateConversationSettings(conversation.id, { model: nextModel }).catch(() => {});
    },
    [conversation.id, workspace],
  );
  const commitEffort = useCallback(
    (nextEffort: AgentReasoningEffort | undefined) => {
      setEffort(nextEffort);
      workspace.updateConversationSettings(conversation.id, { reasoningEffort: nextEffort }).catch(() => {});
    },
    [conversation.id, workspace],
  );
  const commitPermissionMode = useCallback(
    (nextMode: AgentPermissionMode | undefined) => {
      setPermissionMode(nextMode);
      workspace.updateConversationSettings(conversation.id, { permissionMode: nextMode }).catch(() => {});
    },
    [conversation.id, workspace],
  );
  const setPermissionModeWithGuard = useCallback(
    (nextMode: AgentPermissionMode | undefined) => {
      if (nextMode === "full_access") {
        Alert.alert(
          "启用完全访问权限？",
          "Agent 可能不再逐项请求文件或命令授权。只在你信任当前任务和工作区时使用。",
          [
            { text: "取消", style: "cancel" },
            { text: "启用", onPress: () => commitPermissionMode(nextMode) },
          ],
        );
        return;
      }
      commitPermissionMode(nextMode);
    },
    [commitPermissionMode],
  );

  const settingsMenuActions = useMemo(() => {
    const sections: Array<{ id: string; title: string; subactions: any[] }> = [];
    if (modelMenuActions.length > 1) {
      sections.push({ id: "model_section", title: "模型", subactions: modelMenuActions });
    }
    if (effortMenuActions.length > 0) {
      sections.push({ id: "effort_section", title: "思考强度", subactions: effortMenuActions });
    }
    if (permissionMenuActions.length > 0) {
      sections.push({ id: "permission_section", title: "权限模式", subactions: permissionMenuActions });
    }
    return sections;
  }, [effortMenuActions, modelMenuActions, permissionMenuActions]);
  const compactSettingsLabel = useMemo(() => {
    if (modelMenuActions.length > 1) return formatModel(model, modelOpts);
    if (effortMenuActions.length > 0) return formatEffort(effort);
    return "设置";
  }, [effort, effortMenuActions.length, model, modelMenuActions.length, modelOpts]);
  const handleSettingsMenu = useCallback(
    (eventId: string) => {
      if (eventId.startsWith("model:")) {
        commitModel(valueFromMenuId<string>(eventId.slice("model:".length)));
        return;
      }
      if (eventId.startsWith("effort:")) {
        commitEffort(valueFromMenuId<AgentReasoningEffort>(eventId.slice("effort:".length)));
        return;
      }
      if (eventId.startsWith("permission:")) {
        setPermissionModeWithGuard(valueFromMenuId<AgentPermissionMode>(eventId.slice("permission:".length)));
      }
    },
    [commitEffort, commitModel, setPermissionModeWithGuard],
  );

  const nativePlanCommand = useMemo(
    () =>
      availableCommands.find(
        (command) => command.name === "plan" && command.executionKind === "native" && !command.disabledReason,
      ),
    [availableCommands],
  );

  // Auto-dismiss notices after their configured (or default) duration.
  useEffect(() => {
    if (notices.length === 0) return;
    const timers = notices.map((notice) =>
      setTimeout(
        () => workspace.dismissNotice(notice.id),
        notice.durationMs && notice.durationMs > 0 ? notice.durationMs : 4000,
      ),
    );
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [notices, workspace]);

  const send = useCallback(() => {
    const value = text.trim();
    if (!canSend) return;
    const commandMatch =
      attachments.length === 0 && !running ? commandFromMessage(value, availableCommands) : null;
    if (commandMatch) {
      const run = () => {
        workspace.executeCommand(conversation.id, commandMatch.command, value, commandMatch.args);
        setText("");
        setAttachments([]);
        onAfterSend();
      };
      if (commandMatch.command.destructive) {
        Alert.alert(
          "执行命令？",
          `${commandMatch.command.title} 可能会重置或改变当前会话状态。`,
          [
            { text: "取消", style: "cancel" },
            { text: "执行", style: "destructive", onPress: run },
          ],
        );
        return;
      }
      run();
      return;
    }
    const nextEffort = effort && effortOpts.some((option) => option.value === effort) ? effort : undefined;
    const nextPermissionMode =
      permissionMode && permissionOpts.some((option) => option.value === permissionMode)
        ? permissionMode
        : undefined;
    workspace.sendPrompt(conversation.id, value, {
      model,
      reasoningEffort: nextEffort,
      permissionMode: nextPermissionMode,
      collaborationMode: currentCollaborationMode,
      attachments,
    });
    setText("");
    setAttachments([]);
    onAfterSend();
  }, [
    attachments,
    availableCommands,
    canSend,
    conversation.id,
    currentCollaborationMode,
    effort,
    effortOpts,
    model,
    onAfterSend,
    permissionMode,
    permissionOpts,
    running,
    text,
    workspace,
  ]);

  const handleExecutePlan = useCallback(() => {
    workspace.sendPrompt(conversation.id, "请按上面的计划开始执行。", {
      model,
      reasoningEffort: effort,
      permissionMode,
      collaborationMode: "default",
    });
    onAfterSend();
  }, [conversation.id, effort, model, onAfterSend, permissionMode, workspace]);

  const renameConversation = useCallback(() => {
    if (Platform.OS === "ios" && typeof Alert.prompt === "function") {
      Alert.prompt(
        "重命名对话",
        undefined,
        [
          { text: "取消", style: "cancel" },
          {
            text: "保存",
            onPress: (value?: string) => {
              const title = (value ?? "").trim();
              if (title) workspace.rename(conversation.id, title).catch(() => {});
            },
          },
        ],
        "plain-text",
        conversation.title ?? "",
      );
      return;
    }
    // Android (and any platform without Alert.prompt): in-app modal.
    setRenameDraft(conversation.title ?? "");
    setRenameModalVisible(true);
  }, [conversation.id, conversation.title, workspace]);

  const submitRename = useCallback(() => {
    const title = renameDraft.trim();
    setRenameModalVisible(false);
    if (title) {
      workspace.rename(conversation.id, title).catch(() => {});
    }
  }, [conversation.id, renameDraft, workspace]);

  const insertDictatedText = useCallback((dictated: string) => {
    const insert = dictated.trim();
    if (!insert) return;
    setText((prev) => {
      const pos = Math.min(Math.max(selectionRef.current, 0), prev.length);
      const before = prev.slice(0, pos);
      const after = prev.slice(pos);
      const combined =
        before +
        (before && !before.endsWith(" ") ? " " : "") +
        insert +
        (after && !after.startsWith(" ") ? " " : "") +
        after;
      selectionRef.current = (
        before + (before && !before.endsWith(" ") ? " " : "") + insert
      ).length;
      return combined;
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);
  const dictation = useComposerDictation(insertDictatedText);

  const steerQueuedFollowUp = useCallback(
    (item: AgentTimelineItem) => {
      workspace.sendQueuedFollowUp(conversation.id, item.id, "steer");
      Haptics.selectionAsync().catch(() => {});
      onAfterSend();
    },
    [conversation.id, onAfterSend, workspace],
  );

  const discardQueuedFollowUp = useCallback(
    (item: AgentTimelineItem) => {
      workspace.discardQueuedFollowUp(conversation.id, item.id);
      Haptics.selectionAsync().catch(() => {});
    },
    [conversation.id, workspace],
  );

  const executeSlashCommand = useCallback(
    (command: AgentCommandDescriptor, args = "") => {
      const run = () => {
        const rawText = commandRawText(command, args);
        workspace.executeCommand(conversation.id, command, rawText, args);
        setText("");
        setAttachments([]);
        Haptics.selectionAsync().catch(() => {});
        onAfterSend();
      };
      if (command.destructive) {
        Alert.alert(
          "执行命令？",
          `${command.title} 可能会重置或改变当前会话状态。`,
          [
            { text: "取消", style: "cancel" },
            { text: "执行", style: "destructive", onPress: run },
          ],
        );
        return;
      }
      run();
    },
    [conversation.id, onAfterSend, workspace],
  );

  const selectSlashCommand = useCallback(
    (command: AgentCommandDescriptor) => {
      if (!commandToken) return;
      const draftWithoutToken = text.slice(0, commandToken.start).trimEnd();
      if (command.argsMode === "none") {
        executeSlashCommand(command);
        return;
      }
      const replacement = commandRawText(command, "");
      const nextText = `${draftWithoutToken ? `${draftWithoutToken} ` : ""}${replacement} `;
      setText(nextText);
      Haptics.selectionAsync().catch(() => {});
    },
    [commandToken, executeSlashCommand, text],
  );

  const closeSlashCommandPanel = useCallback(() => {
    if (!commandToken) return;
    setText((current) => `${current.slice(0, commandToken.start)}${current.slice(commandToken.end)}`.trimEnd());
  }, [commandToken]);

  // Entries matching the current @token's filter, folders first. Only valid
  // once the fetched directory matches the token's resolved target.
  const mentionMatches = useMemo(() => {
    if (!mentionToken || mentionFetchedDir !== mentionTargetDir) return [];
    const filter = mentionToken.filter.toLowerCase();
    return mentionEntries
      .filter((entry) => entry.name.toLowerCase().includes(filter))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 50);
  }, [mentionEntries, mentionFetchedDir, mentionTargetDir, mentionToken]);

  // Insert the picked entry, replacing the trailing @token. Folders keep a
  // trailing slash so the palette drills in; files terminate with a space.
  const selectMention = useCallback(
    (entry: AgentFileEntry) => {
      if (!mentionToken) return;
      const base = (conversation.cwd || ".").replace(/\/+$/, "");
      const rel =
        base && entry.path.startsWith(base) ? entry.path.slice(base.length).replace(/^\/+/, "") : entry.name;
      setText((current) => {
        const head = current.slice(0, mentionToken.start);
        const next = `${head}@${rel}${entry.isDirectory ? "/" : " "}`;
        selectionRef.current = next.length;
        return next;
      });
      Haptics.selectionAsync().catch(() => {});
    },
    [conversation.cwd, mentionToken],
  );

  const closeMentionPanel = useCallback(() => {
    if (!mentionToken) return;
    setText((current) => `${current.slice(0, mentionToken.start)}${current.slice(mentionToken.end)}`);
  }, [mentionToken]);

  // Navigate the @-mention browser up one directory by dropping the last
  // segment of the token's dir part. Bounded at the conversation cwd (empty
  // dir → no-op), mirroring the web composer's cwd-relative mentions.
  const navigateMentionUp = useCallback(() => {
    if (!mentionToken || !mentionToken.dir) return;
    const dir = mentionToken.dir;
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    setText((current) => {
      const head = current.slice(0, mentionToken.start);
      const next = `${head}@${parent}${parent ? "/" : ""}`;
      selectionRef.current = next.length;
      return next;
    });
    Haptics.selectionAsync().catch(() => {});
  }, [mentionToken]);

  const cancelRunningTurn = useCallback(() => {
    Alert.alert(
      "停止当前任务？",
      "Agent 会中断当前运行中的回复和工具调用。",
      [
        { text: "继续运行", style: "cancel" },
        {
          text: "停止",
          style: "destructive",
          onPress: () => workspace.cancel(conversation.id),
        },
      ],
    );
  }, [conversation.id, workspace]);

  const appendImageBlocks = useCallback((assets: ImagePicker.ImagePickerAsset[]) => {
    const blocks = assets
      .map(imageBlockFromAsset)
      .filter((block): block is AgentContentBlock => Boolean(block));
    if (blocks.length === 0) {
      Alert.alert("无法添加图片", "没有读取到图片数据，请换一张图片再试。");
      return;
    }

    const oversized = blocks.find((block) => (block.data?.length ?? 0) > MAX_IMAGE_DATA_URL_LENGTH);
    if (oversized) {
      Alert.alert("图片太大", "请选择较小的截图或照片。");
      return;
    }

    setAttachments((current) => {
      const room = MAX_IMAGE_ATTACHMENTS - current.length;
      if (room <= 0) {
        Alert.alert("图片已满", `一次最多发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
        return current;
      }
      return [...current, ...blocks.slice(0, room)];
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const pickImages = useCallback(
    async (source: "camera" | "library") => {
      if (!supportsImages) {
        Alert.alert("当前 Agent 不支持图片", "请切换到 Claude 或 Codex Agent，或使用支持图片输入的自定义 Agent。");
        return;
      }
      if (attachments.length >= MAX_IMAGE_ATTACHMENTS) {
        Alert.alert("图片已满", `一次最多发送 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
        return;
      }

      try {
        if (source === "camera") {
          const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
          if (!permissionResult.granted) {
            Alert.alert("需要相机权限", "允许访问相机后才能拍照发送。");
            return;
          }
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"],
            base64: true,
            quality: 0.55,
          });
          if (!result.canceled) appendImageBlocks(result.assets.slice(0, 1));
          return;
        }

        const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permissionResult.granted) {
          Alert.alert("需要相册权限", "允许访问相册后才能选择图片发送。");
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          base64: true,
          quality: 0.55,
          allowsMultipleSelection: true,
          selectionLimit: Math.max(1, MAX_IMAGE_ATTACHMENTS - attachments.length),
        });
        if (!result.canceled) appendImageBlocks(result.assets);
      } catch (error) {
        Alert.alert("无法添加图片", error instanceof Error ? error.message : "图片选择失败");
      }
    },
    [appendImageBlocks, attachments.length, supportsImages],
  );

  const showAttachSheet = useCallback(() => {
    if (!supportsImages) {
      Alert.alert("当前 Agent 不支持图片", "请切换到 Claude 或 Codex Agent，或使用支持图片输入的自定义 Agent。");
      return;
    }
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["取消", "拍照", "从相册选择"], cancelButtonIndex: 0 },
        (index) => {
          if (index === 1) pickImages("camera").catch(() => {});
          if (index === 2) pickImages("library").catch(() => {});
        },
      );
      return;
    }
    Alert.alert("添加图片", undefined, [
      { text: "取消", style: "cancel" },
      { text: "拍照", onPress: () => pickImages("camera").catch(() => {}) },
      { text: "从相册选择", onPress: () => pickImages("library").catch(() => {}) },
    ]);
  }, [pickImages, supportsImages]);

  useImperativeHandle(
    ref,
    () => ({
      setDraft: (value: string) => {
        setText(value);
        selectionRef.current = value.length;
        requestAnimationFrame(() => composerInputRef.current?.focus());
        Haptics.selectionAsync().catch(() => {});
      },
      focus: () => composerInputRef.current?.focus(),
      openRename: () => renameConversation(),
    }),
    [renameConversation],
  );

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: bottomOffset,
      }}
    >
      <View
        onLayout={(event) => {
          const nextHeight = Math.ceil(event.nativeEvent.layout.height);
          onHeightChange(nextHeight);
        }}
        style={{
          paddingHorizontal: 10,
          paddingTop: 6,
          paddingBottom: Math.max(bottomInset + 6, 12),
          backgroundColor: "transparent",
          gap: 6,
        }}
      >
        <NoticeStrip notices={notices} theme={theme} onDismiss={(id) => workspace.dismissNotice(id)} />
        {planReady ? (
          <View
            style={{
              marginBottom: 6,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              borderRadius: 16,
              borderCurve: "continuous",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.accent,
              backgroundColor: theme.accentLight,
              paddingHorizontal: 14,
              paddingVertical: 11,
            }}
          >
            <AppSymbol name="checklist" size={15} color={theme.accent} />
            <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 13, lineHeight: 18 }}>
              计划已就绪。执行它，或在下方继续补充。
            </Text>
            <Pressable
              onPress={handleExecutePlan}
              hitSlop={6}
              style={({ pressed }) => ({
                borderRadius: 999,
                paddingHorizontal: 14,
                paddingVertical: 7,
                backgroundColor: pressed ? theme.accentSecondary : theme.accent,
              })}
            >
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>执行计划</Text>
            </Pressable>
          </View>
        ) : null}
        {dictation.pressing ? (
          <View
            style={{
              marginBottom: 6,
              borderRadius: 16,
              borderCurve: "continuous",
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: dictation.inCancelZone ? theme.error : theme.separator,
              backgroundColor: dictation.inCancelZone ? theme.errorLight : theme.bgCard,
              paddingHorizontal: 14,
              paddingVertical: 12,
              gap: 6,
              shadowColor: "#000",
              shadowOpacity: theme.mode === "dark" ? 0.26 : 0.1,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
              elevation: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.error }} />
              <Text style={{ flex: 1, color: theme.text, fontSize: 15, lineHeight: 21 }} numberOfLines={3}>
                {dictation.liveText || "正在听…"}
              </Text>
            </View>
            <Text
              style={{
                textAlign: "center",
                fontSize: 12,
                fontWeight: dictation.inCancelZone ? "800" : "600",
                color: dictation.inCancelZone ? theme.error : theme.textTertiary,
              }}
            >
              {dictation.inCancelZone ? "松开取消" : "↑ 上滑取消，松开插入"}
            </Text>
          </View>
        ) : null}
        <View
          style={{
            borderRadius: 22,
            borderCurve: "continuous",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.mode === "light" ? "rgba(60,60,67,0.18)" : "rgba(255,255,255,0.14)",
            backgroundColor: theme.bgCard,
            paddingHorizontal: 0,
            paddingTop: 0,
            paddingBottom: 0,
            gap: 0,
            overflow: "hidden",
            shadowColor: "#000",
            shadowOpacity: theme.mode === "dark" ? 0.26 : 0.1,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: 8,
          }}
        >
          {queuedFollowUps.length > 0 ? (
            <QueuedFollowUpList
              items={queuedFollowUps}
              theme={theme}
              canSteer={canSteerRunningTurn}
              onSteer={steerQueuedFollowUp}
              onDiscard={discardQueuedFollowUp}
            />
          ) : null}
          {attachments.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={{ flexDirection: "row", gap: 8 }}>
                {attachments.map((attachment, index) => (
                  <View
                    key={`${attachment.mimeType}-${index}`}
                    style={{
                      width: 70,
                      height: 70,
                      borderRadius: 12,
                      borderCurve: "continuous",
                      overflow: "hidden",
                      backgroundColor: theme.bgInput,
                    }}
                  >
                    {attachment.data ? (
                      <Image source={{ uri: attachment.data }} contentFit="cover" style={{ width: "100%", height: "100%" }} />
                    ) : null}
                    <Pressable
                      onPress={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      hitSlop={8}
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(0,0,0,0.55)",
                      }}
                    >
                      <AppSymbol name="xmark" size={12} color="#fff" />
                    </Pressable>
                  </View>
                ))}
              </View>
            </ScrollView>
          ) : null}
          {commandPanelVisible && commandToken ? (
            <SlashCommandPanel
              commands={availableCommands}
              query={commandToken.query}
              theme={theme}
              onSelect={selectSlashCommand}
              onClose={closeSlashCommandPanel}
            />
          ) : null}
          {mentionPanelVisible && mentionToken ? (
            <MentionPanel
              entries={mentionMatches}
              loading={mentionLoading}
              error={mentionError}
              currentDir={mentionTargetDir ?? ""}
              canNavigateUp={Boolean(mentionToken.dir)}
              theme={theme}
              onSelect={selectMention}
              onNavigateUp={navigateMentionUp}
              onClose={closeMentionPanel}
            />
          ) : null}
          <TextInput
            ref={composerInputRef}
            value={text}
            onChangeText={setText}
            onSelectionChange={(event) => {
              selectionRef.current = event.nativeEvent.selection.end;
            }}
            placeholder={
              canSteerRunningTurn
                ? "要求后续变更"
                : waitingPermission
                  ? "Agent 运行中，可先编辑草稿"
                  : turnRunning
                    ? "发送将加入队列，结束后自动发送"
                    : "给 Agent 发送消息"
            }
            placeholderTextColor={theme.textTertiary}
            multiline
            keyboardType="default"
            textContentType="none"
            autoCapitalize="sentences"
            autoCorrect
            spellCheck={false}
            returnKeyType="default"
            blurOnSubmit={false}
            style={{
              minHeight: 50,
              maxHeight: 132,
              color: theme.text,
              fontSize: 14,
              lineHeight: 20,
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 6,
            }}
          />
          {running ? (
            <Text style={{ color: theme.textTertiary, fontSize: 11, lineHeight: 15, paddingHorizontal: 14, paddingBottom: 2 }}>
              {canSteerRunningTurn
                ? "Codex 正在工作，发送会加入队列；点队列里的引导可立即打断当前回复。"
                : waitingPermission
                  ? "当前任务正在等待授权，请先处理授权请求或停止任务。"
                  : "Agent 正在工作，发送会加入队列，本回合结束后自动发送。"}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10 }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }}>
              {supportsImages ? (
                <Pressable
                  onPress={showAttachSheet}
                  accessibilityRole="button"
                  accessibilityLabel="添加图片"
                  style={({ pressed }) => ({
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? theme.bgInput : "transparent",
                  })}
                >
                  <AppSymbol name="plus" size={18} color={theme.textSecondary} />
                </Pressable>
              ) : null}
              {nativePlanCommand ? (
                <Pressable
                  onPress={() => {
                    const targetName = currentCollaborationMode === "plan" ? "exit-plan" : "plan";
                    const command = availableCommands.find((item) => item.name === targetName) ?? nativePlanCommand;
                    if (command?.disabledReason) {
                      Alert.alert("命令不可用", command.disabledReason);
                      return;
                    }
                    executeSlashCommand(command);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={currentCollaborationMode === "plan" ? "退出计划模式" : "进入计划模式"}
                  accessibilityState={{ selected: currentCollaborationMode === "plan" }}
                  style={({ pressed }) => ({
                    height: 30,
                    borderRadius: 999,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                    gap: 5,
                    paddingHorizontal: 11,
                    backgroundColor:
                      currentCollaborationMode === "plan"
                        ? pressed
                          ? theme.accentLight
                          : "rgba(173,198,255,0.28)"
                        : pressed
                          ? theme.bgInput
                          : theme.mode === "light"
                            ? "rgba(60,60,67,0.06)"
                            : "rgba(255,255,255,0.08)",
                  })}
                >
                  <AppSymbol name="checklist" size={13} color={currentCollaborationMode === "plan" ? theme.accent : theme.textSecondary} />
                  <Text style={{ color: currentCollaborationMode === "plan" ? theme.accent : theme.textSecondary, fontSize: 11, fontWeight: "800" }}>
                    Plan
                  </Text>
                </Pressable>
              ) : null}
              <MenuView actions={settingsMenuActions} onPressAction={({ nativeEvent }) => handleSettingsMenu(nativeEvent.event)}>
                <View
                  accessibilityRole="button"
                  accessibilityLabel="模型与权限设置"
                  style={{
                    minHeight: 30,
                    borderRadius: 999,
                    paddingHorizontal: 9,
                    paddingVertical: 6,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    backgroundColor: permissionMode === "full_access" ? "rgba(255,214,10,0.20)" : "transparent",
                  }}
                >
                  <AppSymbol name="bolt" size={12} color={permissionMode === "full_access" ? theme.warning : theme.textSecondary} />
                  <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: "800" }} numberOfLines={1}>
                    {compactSettingsLabel}
                  </Text>
                  <AppSymbol name="chevron.down" size={9} color={theme.textTertiary} />
                </View>
              </MenuView>
            </View>
            {dictation.available ? (
              <View
                {...dictation.panHandlers}
                accessibilityRole="button"
                accessibilityLabel="按住说话"
                style={{
                  width: 34,
                  height: 30,
                  borderRadius: 15,
                  borderCurve: "continuous",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: dictation.pressing
                    ? dictation.inCancelZone
                      ? theme.errorLight
                      : theme.accent
                    : "transparent",
                }}
              >
                <AppSymbol
                  name={dictation.pressing ? "mic.fill" : "mic"}
                  size={15}
                  color={dictation.pressing ? (dictation.inCancelZone ? theme.error : "#fff") : theme.textTertiary}
                />
              </View>
            ) : null}
            {running ? (
              <Pressable
                onPress={cancelRunningTurn}
                accessibilityRole="button"
                accessibilityLabel="停止当前任务"
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.bgElevated : theme.mode === "light" ? "#111111" : "#f6f6f7",
                })}
              >
                <AppSymbol name="stop.fill" size={14} color={theme.mode === "light" ? "#ffffff" : "#111111"} />
              </Pressable>
            ) : null}
            {!waitingPermission ? (
              <Pressable
                onPress={send}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel={turnRunning ? "加入队列发送" : "发送消息"}
                accessibilityState={{ disabled: !canSend }}
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                  opacity: canSend ? 1 : 0.45,
                })}
              >
                <AppSymbol name="arrow.up" size={18} color="#fff" />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      <Modal
        visible={renameModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameModalVisible(false)}
      >
        <Pressable
          onPress={() => setRenameModalVisible(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", paddingHorizontal: 28 }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              width: "100%",
              maxWidth: 360,
              borderRadius: 18,
              borderCurve: "continuous",
              backgroundColor: theme.bgCard,
              padding: 18,
              gap: 14,
            }}
          >
            <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>重命名对话</Text>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              autoFocus
              placeholder="对话标题"
              placeholderTextColor={theme.textTertiary}
              returnKeyType="done"
              onSubmitEditing={submitRename}
              style={{
                minHeight: 44,
                borderRadius: 11,
                borderCurve: "continuous",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                backgroundColor: theme.bgInput,
                paddingHorizontal: 12,
                color: theme.text,
                fontSize: 15,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Pressable
                onPress={() => setRenameModalVisible(false)}
                style={({ pressed }) => ({
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: pressed ? theme.bgInput : "transparent",
                })}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 14, fontWeight: "700" }}>取消</Text>
              </Pressable>
              <Pressable
                onPress={submitRename}
                disabled={!renameDraft.trim()}
                style={({ pressed }) => ({
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                  opacity: renameDraft.trim() ? 1 : 0.45,
                })}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>保存</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
});
