import { memo, useCallback, useMemo, useState } from "react";
import {
  Alert,
  Clipboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import Markdown from "react-native-markdown-display";

import { AppSymbol } from "../../../components/AppSymbol";
import type { Theme } from "../../../theme";
import type { AgentContentBlock } from "../types";
import { diffLineColors, syntaxTokens } from "../lib/diff";
import { MONO_FONT } from "../lib/format";

async function copy(value: string): Promise<boolean> {
  try {
    Clipboard.setString(value);
    const copied = typeof Clipboard.getString === "function" ? await Clipboard.getString() : value;
    Haptics.selectionAsync().catch(() => {});
    return copied === value || copied.length > 0;
  } catch {
    return false;
  }
}

export function CodeBlock({
  label,
  code,
  theme,
  maxLines,
}: {
  label: string;
  code: string;
  theme: Theme;
  maxLines?: number;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    copy(code).then((ok) => {
      if (!ok) {
        Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {
      Alert.alert("复制失败", "系统剪贴板暂不可用，请长按文本手动复制。");
    });
  }, [code]);

  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        backgroundColor: theme.bgInput,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 30,
          paddingHorizontal: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Text style={{ flex: 1, color: theme.textTertiary, fontSize: 11, fontWeight: "700" }} numberOfLines={1}>
          {label}
        </Text>
        <Pressable
          onPress={onCopy}
          hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 }}
        >
          <AppSymbol name={copied ? "checkmark" : "doc.on.doc"} size={12} color={theme.textTertiary} />
          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "700" }}>
            {copied ? "已复制" : "复制"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
        <Text
          selectable
          numberOfLines={maxLines}
          style={{
            minWidth: "100%",
            paddingHorizontal: 10,
            paddingVertical: 9,
            color: theme.textSecondary,
            fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

export function DiffBlock({
  diff,
  theme,
  expanded,
}: {
  diff: string;
  theme: Theme;
  expanded: boolean;
}) {
  const lines = diff.split("\n");
  const visibleLines = expanded ? lines.slice(0, 500) : lines.slice(0, 18);
  return (
    <View
      style={{
        borderRadius: 10,
        borderCurve: "continuous",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.separator,
        backgroundColor: theme.bgInput,
        overflow: "hidden",
      }}
    >
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: "100%", paddingVertical: 6 }}>
          {visibleLines.map((line, index) => {
            const colors = diffLineColors(line, theme);
            return (
              <Text
                key={`${index}-${line.slice(0, 12)}`}
                selectable
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 1,
                  minWidth: "100%",
                  color: colors.color,
                  backgroundColor: colors.backgroundColor,
                  fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
                  fontSize: 11,
                  lineHeight: 16,
                }}
              >
                {line || " "}
              </Text>
            );
          })}
          {visibleLines.length < lines.length ? (
            <Text
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                color: theme.textTertiary,
                fontSize: 11,
                fontWeight: "700",
              }}
            >
              还有 {lines.length - visibleLines.length} 行
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

export function MessageContent({
  blocks,
  fallbackText,
  theme,
  inverse = false,
  monospace = false,
}: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
}) {
  const normalized = blocks?.length
    ? blocks
    : fallbackText
      ? [{ type: "text" as const, text: fallbackText }]
      : [];

  return (
    <View style={{ gap: 9 }}>
      {normalized.map((block, index) => {
        if (block.type === "image") {
          return (
            <View
              key={`image-${index}`}
              style={{
                borderRadius: 12,
                borderCurve: "continuous",
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: inverse ? "rgba(255,255,255,0.28)" : theme.separator,
                backgroundColor: inverse ? "rgba(255,255,255,0.12)" : theme.bgInput,
              }}
            >
              {block.data ? (
                <Image
                  source={{ uri: block.data }}
                  contentFit="cover"
                  style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3 }}
                />
              ) : (
                <View style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3, alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <AppSymbol name="photo" size={22} color={inverse ? "rgba(255,255,255,0.78)" : theme.textTertiary} />
                  <Text style={{ color: inverse ? "rgba(255,255,255,0.78)" : theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                    图片附件
                  </Text>
                </View>
              )}
            </View>
          );
        }

        return block.text ? (
          <MarkdownContent key={`text-${index}`} text={block.text} theme={theme} inverse={inverse} monospace={monospace} />
        ) : null;
      })}
    </View>
  );
}

export function UserMessageContent({
  blocks,
  fallbackText,
  theme,
}: {
  blocks?: AgentContentBlock[];
  fallbackText?: string;
  theme: Theme;
}) {
  const normalized = blocks?.length
    ? blocks
    : fallbackText
      ? [{ type: "text" as const, text: fallbackText }]
      : [];

  return (
    <View style={{ gap: 8 }}>
      {normalized.map((block, index) => {
        if (block.type === "image") {
          return (
            <View
              key={`image-${index}`}
              style={{
                borderRadius: 10,
                borderCurve: "continuous",
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.separator,
                backgroundColor: theme.bgInput,
              }}
            >
              {block.data ? (
                <Image
                  source={{ uri: block.data }}
                  contentFit="cover"
                  style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3 }}
                />
              ) : (
                <View style={{ width: 220, maxWidth: "100%", aspectRatio: 4 / 3, alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <AppSymbol name="photo" size={22} color={theme.textTertiary} />
                  <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                    图片附件
                  </Text>
                </View>
              )}
            </View>
          );
        }

        return block.text ? (
          <Text
            key={`text-${index}`}
            selectable
            style={{
              color: theme.textSecondary,
              fontSize: 14,
              lineHeight: 20,
              fontWeight: "500",
            }}
          >
            {block.text.trim()}
          </Text>
        ) : null;
      })}
    </View>
  );
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
  theme,
  inverse = false,
  monospace = false,
}: {
  text: string;
  theme: Theme;
  inverse?: boolean;
  monospace?: boolean;
}) {
  const color = inverse ? "#fff" : theme.text;
  const secondaryColor = inverse ? "rgba(255,255,255,0.82)" : theme.textSecondary;
  const markdownStyle = useMemo(() => ({
    body: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 14 : 14,
      lineHeight: inverse ? 21 : 21,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 9,
    },
    heading1: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 18 : 16,
      lineHeight: inverse ? 25 : 23,
      fontWeight: "800" as const,
      marginTop: 6,
      marginBottom: 8,
    },
    heading2: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: inverse ? 16 : 15,
      lineHeight: inverse ? 23 : 22,
      fontWeight: "800" as const,
      marginTop: 6,
      marginBottom: 7,
    },
    heading3: {
      color,
      fontFamily: !inverse && monospace ? MONO_FONT : undefined,
      fontSize: 14,
      lineHeight: 21,
      fontWeight: "800" as const,
      marginTop: 4,
      marginBottom: 6,
    },
    heading4: {
      color,
      fontSize: 14,
      lineHeight: 21,
      fontWeight: "800" as const,
      marginTop: 4,
      marginBottom: 5,
    },
    strong: {
      color,
      fontWeight: "800" as const,
    },
    em: {
      color,
      fontStyle: "italic" as const,
    },
    s: {
      color: secondaryColor,
      textDecorationLine: "line-through" as const,
    },
    link: {
      color: inverse ? "#fff" : theme.accent,
      textDecorationLine: "underline" as const,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftColor: inverse ? "rgba(255,255,255,0.4)" : theme.separator,
      borderLeftWidth: 3,
      paddingLeft: 10,
      marginLeft: 0,
      marginBottom: 8,
    },
    bullet_list: {
      marginBottom: 8,
    },
    ordered_list: {
      marginBottom: 8,
    },
    list_item: {
      marginBottom: 3,
    },
    bullet_list_icon: {
      color: secondaryColor,
    },
    ordered_list_icon: {
      color: secondaryColor,
    },
    code_inline: {
      color,
      backgroundColor: inverse ? "rgba(255,255,255,0.18)" : theme.bgInput,
      borderWidth: 0,
      borderRadius: 5,
      paddingHorizontal: 4,
      fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
      fontSize: 13,
    },
    fence: {
      backgroundColor: "transparent",
    },
    code_block: {
      backgroundColor: "transparent",
    },
    table: {
      borderColor: theme.separator,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 8,
      overflow: "hidden" as const,
      marginBottom: 8,
    },
    th: {
      backgroundColor: inverse ? "rgba(255,255,255,0.16)" : theme.bgInput,
      borderColor: theme.separator,
      padding: 8,
    },
    tr: {
      borderColor: theme.separator,
    },
    td: {
      borderColor: theme.separator,
      padding: 8,
    },
    hr: {
      backgroundColor: inverse ? "rgba(255,255,255,0.28)" : theme.separator,
      height: StyleSheet.hairlineWidth,
      marginVertical: 8,
    },
  }), [color, inverse, monospace, secondaryColor, theme]);
  const rules = useMemo(() => ({
    fence: (node: any) => (
      <CodeBlock
        key={node.key}
        label={node.sourceInfo || "代码"}
        code={node.content ?? ""}
        theme={theme}
      />
    ),
    code_block: (node: any) => (
      <CodeBlock
        key={node.key}
        label="代码"
        code={node.content ?? ""}
        theme={theme}
      />
    ),
  }), [theme]);
  return (
    <View style={{ width: "100%" }}>
      <Markdown
        mergeStyle={false}
        style={markdownStyle}
        rules={rules}
        onLinkPress={(url) => {
          if (!/^https?:\/\//i.test(url)) return false;
          Linking.openURL(url).catch(() => {});
          return false;
        }}
      >
        {text}
      </Markdown>
    </View>
  );
});

export function HighlightedCodeLine({
  line,
  lineNumber,
  language,
  theme,
}: {
  line: string;
  lineNumber: number;
  language: string;
  theme: Theme;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", minHeight: 19 }}>
      <Text
        style={{
          width: 42,
          color: theme.textTertiary,
          fontSize: 11,
          lineHeight: 19,
          fontFamily: MONO_FONT,
          textAlign: "right",
          paddingRight: 10,
        }}
      >
        {lineNumber}
      </Text>
      <Text selectable style={{ flex: 1, color: theme.textSecondary, fontSize: 12, lineHeight: 19, fontFamily: MONO_FONT }}>
        {syntaxTokens(line, language, theme).map((token, index) => (
          <Text key={`${lineNumber}:${index}`} style={{ color: token.color, fontWeight: token.fontWeight }}>
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}
