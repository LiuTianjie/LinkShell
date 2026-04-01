import React from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../theme";

interface KeyboardAccessoryProps {
  nativeID: string;
  title?: string;
  actionLabel?: string;
  onActionPress?: () => void;
  children?: React.ReactNode;
}

export function KeyboardAccessory({
  nativeID,
  title = "输入",
  actionLabel,
  onActionPress,
  children,
}: KeyboardAccessoryProps) {
  const { theme } = useTheme();

  if (Platform.OS !== "ios") {
    return null;
  }

  return (
    <InputAccessoryView nativeID={nativeID}>
      <View
        style={[
          styles.toolbar,
          { backgroundColor: theme.keyboardBarBg, borderTopWidth: 1, borderTopColor: theme.keyboardBarBorder },
        ]}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: theme.textSecondary }]}>{title}</Text>
          <View style={styles.actions}>
            {actionLabel && onActionPress ? (
              <Pressable onPress={onActionPress} hitSlop={8}>
                <Text style={[styles.action, { color: theme.accent }]}>{actionLabel}</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={Keyboard.dismiss} hitSlop={8}>
              <Text style={[styles.action, { color: theme.accent }]}>完成</Text>
            </Pressable>
          </View>
        </View>
        {children ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.contentRow}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        ) : null}
      </View>
    </InputAccessoryView>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    paddingTop: 8,
    paddingBottom: 8,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
  },
  contentRow: {
    gap: 8,
    paddingHorizontal: 10,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  action: {
    fontSize: 15,
    fontWeight: "600",
  },
});