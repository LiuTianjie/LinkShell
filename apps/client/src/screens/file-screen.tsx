import { RpcError } from "@linkshell/wire";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { AppMenu } from "@/components/app-menu";
import { AcpFileEditor } from "@/components/acp-file-editor";
import { Icon } from "@/components/icon";
import { ContentWidth, useContentWidth } from "@/lib/content-width";
import { HeaderActions, useHeaderTitleWidth, type HeaderMenuItem } from "@/components/header-actions";
import { ScrollableState } from "@/components/scrollable-state";
import { Markdown } from "@/components/markdown";
import { EmptyState, LoadingState } from "@/components/state-views";
import { useConnection } from "@/lib/client";
import { baseName, fileSize, relativeTime, shortPath } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { LinkBase } from "@/lib/links";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

type Loaded = {
  path: string;
  size: number;
  modifiedAt: number;
  kind: "text" | "image" | "binary";
  text?: string;
  data?: string;
  mimeType?: string;
  /** Text: more of the file follows what is loaded. */
  truncated: boolean;
  nextOffset?: number;
};

const MARKDOWN = /\.(md|mdx|markdown)$/i;
const LINE_HEIGHT = 19;

/** Text comes a part at a time, and no more of it than this is ever on screen (or in memory). */
const PART = 262_144;
const MAX_TEXT = 2 * 1024 * 1024;

/** Whether the viewer has taken all it will of a file that goes on. */
function atLimit(file: Loaded): boolean {
  // A part can end a few bytes early, on a whole character.
  return file.truncated && MAX_TEXT - (file.nextOffset ?? MAX_TEXT) < 1024;
}

/** The end of a file that goes on: load the next part, or say why there is no more. */
function MoreRow({ file, state, onPress }: { file: Loaded; state: "idle" | "loading" | "failed"; onPress: () => void }) {
  const width = useContentWidth();
  if (!file.truncated) return null;
  const note = { color: colors.secondaryLabel, textAlign: "center" } as const;
  if (atLimit(file)) {
    return (
      // Stay within the current pane beside lines that run past it.
      <View style={{ width, paddingHorizontal: 16, paddingVertical: 14 }}>
        <Text style={[type.footnote, note]}>文件较大，只显示前 2 MB（共 {fileSize(file.size)}）</Text>
      </View>
    );
  }
  return (
    <Pressable
      disabled={state === "loading"}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="继续加载"
      style={{ width, alignItems: "center", gap: 3, paddingHorizontal: 16, paddingVertical: 14 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, minHeight: 20 }}>
        {state === "loading" ? <ActivityIndicator size="small" color={colors.secondaryLabel} /> : null}
        <Text style={[type.subhead, { color: state === "failed" ? colors.danger : colors.accent, fontWeight: "600" }]}>
          {state === "loading" ? "正在加载…" : state === "failed" ? "加载失败，点按重试" : "继续加载"}
        </Text>
      </View>
      <Text style={[type.caption, note, { fontVariant: ["tabular-nums"] }]}>
        已显示 {fileSize(file.nextOffset ?? 0)}，共 {fileSize(file.size)}
      </Text>
    </Pressable>
  );
}

/** Code and logs: line numbers, no wrapping, the linked line highlighted and scrolled to. */
function CodeView({ text, line, wrap, footer }: { text: string; line?: number; wrap: boolean; footer?: React.ReactElement }) {
  const insets = usePageInsets();
  const width = useContentWidth();
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const gutter = String(lines.length).length * 8 + 18;
  const list = useRef<FlatList<string>>(null);
  const longest = useMemo(() => lines.reduce((max, l) => Math.max(max, l.length), 0), [lines]);

  // Once: a part loaded later mustn't pull the reader back to the linked line.
  const shown = useRef(false);
  useEffect(() => {
    if (!line || line > lines.length || shown.current) return;
    const timer = setTimeout(() => {
      shown.current = true;
      list.current?.scrollToIndex({ index: Math.max(line - 6, 0), animated: false });
    }, 60);
    return () => clearTimeout(timer);
  }, [line, lines.length]);

  const body = (
      <FlatList
        ref={list}
        data={lines}
        keyExtractor={(_, index) => String(index)}
        getItemLayout={wrap ? undefined : (_, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index, index })}
        onScrollToIndexFailed={({ index }) => setTimeout(() => list.current?.scrollToIndex({ index, animated: false }), 120)}
        initialNumToRender={80}
        windowSize={15}
        contentContainerStyle={{ paddingVertical: 10, paddingBottom: insets.bottom + 24 }}
        style={{ minWidth: width, ...(wrap ? { flex: 1 } : {}) }}
        ListFooterComponent={footer}
        renderItem={({ item, index }) => {
          const current = index + 1 === line;
          return (
            <View style={{ flexDirection: "row", minHeight: LINE_HEIGHT, backgroundColor: current ? colors.accentSoft : undefined }}>
              <Text
                style={{
                  width: gutter,
                  paddingRight: 10,
                  textAlign: "right",
                  fontFamily: mono,
                  fontSize: 12,
                  lineHeight: LINE_HEIGHT,
                  color: current ? colors.accent : colors.tertiaryLabel,
                }}
              >
                {index + 1}
              </Text>
              <Text
                selectable
                style={{
                  fontFamily: mono,
                  fontSize: 12.5,
                  lineHeight: LINE_HEIGHT,
                  color: colors.codeText,
                  paddingRight: 16,
                  ...(wrap ? { flex: 1 } : { minWidth: longest * 7.6 }),
                }}
              >
                {item || " "}
              </Text>
            </View>
          );
        }}
      />
  );
  if (wrap) return body;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
      {body}
    </ScrollView>
  );
}

/** Prose-like files wrap; code keeps its lines. */
const WRAPS = /\.(log|txt|out|err|csv|tsv|rst|adoc|org)$|^[^.]+$/i;

/** A file on the computer, opened from a link in a message or from the project's files. */
export function FileScreen() {
  const { path, line } = useLocalSearchParams<{ path: string; line?: string }>();
  return <FileContent key={path} path={path} line={line} />;
}

/** A pane keeps the same reader mounted while the directory column is hidden. */
export function FileContent({ path, line, embedded = false, onBack, backLabel = "返回文件列表" }: { path: string; line?: string; embedded?: boolean; onBack?: () => void; backLabel?: string }) {
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const headerTitleWidth = useHeaderTitleWidth(1);
  const { link } = useConnection();
  const insets = usePageInsets();
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ message: string; tooLarge: boolean } | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const target = line ? Number(line) : undefined;
  const [wrap, setWrap] = useState(() => WRAPS.test(baseName(path)));
  const [editing, setEditing] = useState(false);
  const open = useRef(true);

  useEffect(() => {
    open.current = true;
    // (The screen can be pointed at another file without being left.)
    setFile(null);
    setError(null);
    setMore("idle");
    link
      .call("fs.read", { path, maxBytes: PART }, 20_000)
      .then((result) => open.current && setFile(result))
      .catch((reason: unknown) => {
        if (!open.current) return;
        // Too big for a phone: the computer says so, with the size.
        const tooLarge = reason instanceof RpcError && reason.appCode === "too_large";
        setError({ message: reason instanceof Error ? reason.message : String(reason), tooLarge });
      });
    return () => {
      open.current = false;
    };
  }, [link, path]);

  const loadMore = useCallback(() => {
    if (!file || file.kind !== "text" || !file.truncated || file.nextOffset === undefined || atLimit(file) || more === "loading") return;
    const offset = file.nextOffset;
    setMore("loading");
    link.call("fs.read", { path, offset, maxBytes: Math.min(PART, MAX_TEXT - offset) }, 20_000).then(
      (part) => {
        if (!open.current) return;
        setFile((current) =>
          current && current.nextOffset === offset
            ? { ...current, text: (current.text ?? "") + (part.text ?? ""), truncated: part.truncated, nextOffset: part.nextOffset }
            : current,
        );
        setMore("idle");
      },
      () => open.current && setMore("failed"),
    );
  }, [file, link, more, path]);

  // A link to a line further down than the first part reaches: keep loading up to it.
  const lineCount = useMemo(() => (target && file?.text ? file.text.split("\n").length : 0), [target, file?.text]);
  useEffect(() => {
    if (target && more === "idle" && lineCount > 0 && lineCount <= target) loadMore();
  }, [target, more, lineCount, loadMore]);

  const name = baseName(path);
  const markdown = MARKDOWN.test(path);
  const directory = path.slice(0, path.length - name.length).replace(/\/$/, "");
  const footer = file ? <MoreRow file={file} state={more} onPress={loadMore} /> : undefined;

  const items: HeaderMenuItem[] = [
    ...(file?.kind === "text" && !file.truncated ? [{ title: "AI 编辑建议", icon: { sf: "pencil" as const, md: "edit" as const }, onPress: () => setEditing(true) }] : []),
    ...(file?.text !== undefined
      ? [
          {
            title: "复制内容",
            icon: { sf: "doc.on.doc", md: "content_copy" } as const,
            onPress: () => {
              void Clipboard.setStringAsync(file.text ?? "");
              haptics.success();
            },
          },
        ]
      : []),
    ...(!markdown && file?.kind === "text"
      ? [{ title: wrap ? "不换行" : "自动换行", icon: { sf: "text.word.spacing", md: "wrap_text" } as const, onPress: () => setWrap((value) => !value) }]
      : []),
    {
      title: "复制路径",
      icon: { sf: "link", md: "link" },
      onPress: () => {
        void Clipboard.setStringAsync(path);
        haptics.success();
      },
    },
  ];

  return (
    <View onLayout={(event) => setPaneWidth(event.nativeEvent.layout.width)} style={{ flex: 1, minWidth: 0, backgroundColor: markdown ? colors.plain : colors.code }}>
      <ContentWidth value={paneWidth}>
      {embedded ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, minHeight: 58, borderBottomWidth: 0.5, borderBottomColor: colors.separator }}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={backLabel} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Icon sf="sidebar.left" md="menu_open" size={20} color={colors.accent} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>{name}</Text>
            <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>{file ? `${fileSize(file.size)} · ${relativeTime(file.modifiedAt)}` : shortPath(directory)}</Text>
          </View>
          <AppMenu actions={items.map((item, index) => ({ id: String(index), title: item.title, image: item.icon.sf }))} onPressAction={({ nativeEvent }) => items[Number(nativeEvent.event)]?.onPress()}>
            <View accessibilityRole="button" accessibilityLabel="文件操作" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon sf="ellipsis" md="more_vert" size={20} color={colors.accent} /></View>
          </AppMenu>
        </View>
      ) : <>

      <Stack.Screen
        options={{
          title: name,
          headerTitle: () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", maxWidth: Math.min(240, headerTitleWidth) }}>
              <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
                {name}
              </Text>
              <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                {file ? `${fileSize(file.size)} · ${relativeTime(file.modifiedAt)}` : shortPath(directory)}
              </Text>
            </View>
          ),
          headerShadowVisible: false,
          headerTransparent: false,
          headerStyle: { backgroundColor: (markdown ? colors.plain : colors.code) as string },
        }}
      />
      <HeaderActions
        actions={[
          {
            kind: "menu",
            key: "more",
            icon: { sf: "ellipsis", md: "more_vert" },
            label: "更多",
            items,
          },
        ]}
      />
      </>}
      {editing ? <AcpFileEditor path={path} onClose={() => { setEditing(false); void link.call("fs.read", { path, maxBytes: PART }).then(setFile).catch(() => {}); }} /> : error ? (
        <ScrollableState>
          {error.tooLarge ? (
            <EmptyState icon={{ sf: "doc.badge.ellipsis", md: "draft" }} title={error.message} message="可以在电脑上打开它。" />
          ) : (
            <EmptyState icon={{ sf: "doc.questionmark", md: "draft" }} title="打不开这个文件" message={error.message} />
          )}
        </ScrollableState>
      ) : !file ? (
        <ScrollableState><LoadingState /></ScrollableState>
      ) : file.kind === "image" ? (
        <Image source={{ uri: `data:${file.mimeType};base64,${file.data}` }} style={{ flex: 1, margin: 16 }} contentFit="contain" />
      ) : file.kind === "binary" ? (
        <ScrollableState>
          <EmptyState icon={{ sf: "doc", md: "description" }} title="这是二进制文件，无法预览" message={fileSize(file.size)} />
        </ScrollableState>
      ) : markdown ? (
        <LinkBase value={directory}>
          <ScrollView contentContainerStyle={{ paddingVertical: 18, paddingBottom: insets.bottom + 32 }}>
            <View style={{ paddingHorizontal: 18 }}>
              <Markdown text={file.text ?? ""} />
            </View>
            {footer}
          </ScrollView>
        </LinkBase>
      ) : (
        <CodeView key={path} text={file.text ?? ""} line={target} wrap={wrap} footer={footer} />
      )}
      </ContentWidth>
    </View>
  );
}
