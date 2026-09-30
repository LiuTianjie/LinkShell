import { Stack } from "expo-router/stack";
import { largeTitleHeader } from "@/components/headers";

export default function HomeStack() {
  return (
    <Stack screenOptions={largeTitleHeader}>
      <Stack.Screen name="index" options={{ title: "首页", headerShown: false }} />
    </Stack>
  );
}
