import { useMemo } from "react";
import { Platform, useColorScheme } from "react-native";
import { Stack } from "expo-router/stack";
import { largeTitleHeader } from "@/components/headers";

export default function ProjectsStack() {
  const scheme = useColorScheme();
  const screenOptions = useMemo(() => largeTitleHeader(scheme), [scheme]);
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: "", headerLargeTitleEnabled: false, headerShown: Platform.OS === "ios" }} />
      {/* The list draws its own heading, so its title is empty: name the way back, or VoiceOver says "Back". */}
      <Stack.Screen name="detail" options={{ title: "", headerLargeTitleEnabled: false, headerBackTitle: "项目" }} />
    </Stack>
  );
}
