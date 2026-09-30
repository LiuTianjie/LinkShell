import { Stack } from "expo-router";
import { View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { TimelineSession } from "@/components/timeline/context";
import { Timeline } from "@/components/timeline/timeline";
import { colors } from "@/theme/colors";
import { galleryItems } from "./fixtures";

/** Dev only: every timeline row type, for visual checks on each platform. */
export function GalleryScreen() {
  const inset = useSharedValue(40);
  return (
    <View style={{ flex: 1, backgroundColor: colors.plain }}>
      <Stack.Screen options={{ title: "消息样式", headerShown: true }} />
      <TimelineSession.Provider value="gallery">
      <Timeline
        items={galleryItems}
        planId={galleryItems.find((item) => item.kind === "plan")?.id}
        turnActive
        composerInset={inset}
        keyboardOffset={0}
        onFailedMessage={() => {}}
      />
      </TimelineSession.Provider>
    </View>
  );
}
