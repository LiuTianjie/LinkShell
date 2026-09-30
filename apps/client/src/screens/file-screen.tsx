import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { useConnection } from "@/lib/client";
import { baseName, relativeTime, shortPath } from "@/lib/format";
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
  truncated: boolean;
};

const MARKDOWN = /\.(md|mdx|markdown)$/i;
const LINE_HEIGHT = 19;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Code and logs: line numbers, no wrapping, the linked line highlighted and scrolled to. */
function CodeView({ text, line, wrap }: { text: string; line?: number; wrap: boolean }) {
  const insets = useSafeAreaInsets();
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const gutter = String(lines.length).length * 8 + 18;
  const list = useRef<FlatList<string>>(null);
  const longest = useMemo(() => lines.reduce((max, l) => Math.max(max, l.length), 0), [lines]);

  useEffect(() => {
    if (!line || line > lines.length) return;
    const timer = setTimeout(() => list.current?.scrollToIndex({ index: Math.max(line - 6, 0), animated: false }), 60);
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
        style={{ minWidth: "100%" }}
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

/** A file on the computer, opened from a link in a message. */
export function FileScreen() {
  const { path, line } = useLocalSearchParams<{ path: string; line?: string }>();
  const { link } = useConnection();
  const insets = useSafeAreaInsets();
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = line ? Number(line) : undefined;
  const [wrap, setWrap] = useState(() => WRAPS.test(baseName(path)));

  useEffect(() => {
    let cancelled = false;
    link
      .call("fs.read", { path }, 20_000)
      .then((result) => !cancelled && setFile(result))
      .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [link, path]);

  const name = baseName(path);
  const markdown = MARKDOWN.test(path);
  const directory = path.slice(0, path.length - name.length).replace(/\/$/, "");

  return (
    <View style={{ flex: 1, backgroundColor: markdown ? colors.plain : colors.code }}>
      <Stack.Screen
        options={{
          title: name,
          headerTitle: () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", maxWidth: 240 }}>
              <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
                {name}
              </Text>
              <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                {file ? `${formatSize(file.size)} · ${relativeTime(file.modifiedAt)}` : shortPath(directory)}
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
            items: [
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
            ],
          },
        ]}
      />
      {error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 }}>
          <Icon sf="doc.questionmark" md="draft" size={36} color={colors.tertiaryLabel} />
          <Text style={[type.headline, { color: colors.label }]}>打不开这个文件</Text>
          <Text selectable style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
            {error}
          </Text>
        </View>
      ) : !file ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={colors.secondaryLabel} />
      ) : file.kind === "image" ? (
        <Image source={{ uri: `data:${file.mimeType};base64,${file.data}` }} style={{ flex: 1, margin: 16 }} contentFit="contain" />
      ) : file.kind === "binary" ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <Icon sf="doc" md="description" size={36} color={colors.tertiaryLabel} />
          <Text style={[type.subhead, { color: colors.secondaryLabel }]}>这种文件没法在手机上预览</Text>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {file.truncated ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.fill }]}>
              文件较大，只显示了前 {formatSize(file.text?.length ?? 0)}
            </Text>
          ) : null}
          {markdown ? (
            <LinkBase value={directory}>
              <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 32 }}>
                <Markdown text={file.text ?? ""} />
              </ScrollView>
            </LinkBase>
          ) : (
            <CodeView text={file.text ?? ""} line={target} wrap={wrap} />
          )}
        </View>
      )}
    </View>
  );
}
