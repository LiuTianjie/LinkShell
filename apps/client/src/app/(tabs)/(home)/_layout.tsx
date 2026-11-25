import { useMemo } from "react";
import { useColorScheme } from "react-native";
import { Stack } from "expo-router/stack";
import { largeTitleHeader } from "@/components/headers";

export default function HomeStack() {
  const scheme = useColorScheme();
  const screenOptions = useMemo(() => largeTitleHeader(scheme), [scheme]);
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: "首页", headerShown: false }} />
    </Stack>
  );
}
