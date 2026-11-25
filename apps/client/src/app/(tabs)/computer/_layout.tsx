import { useMemo } from "react";
import { Platform, useColorScheme } from "react-native";
import { Stack } from "expo-router/stack";
import { largeTitleHeader } from "@/components/headers";

export default function ComputerStack() {
  const scheme = useColorScheme();
  const screenOptions = useMemo(() => largeTitleHeader(scheme), [scheme]);
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: "", headerLargeTitleEnabled: false, headerShown: Platform.OS === "ios" }} />
    </Stack>
  );
}
