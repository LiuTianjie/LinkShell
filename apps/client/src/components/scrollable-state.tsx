import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import { usePageInsets } from "./adaptive-page";

/** Standalone states stay centered when they fit, and scroll in short panes or large text. */
export function ScrollableState({ children }: { children: ReactNode }) {
  const insets = usePageInsets();
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {children}
    </ScrollView>
  );
}
