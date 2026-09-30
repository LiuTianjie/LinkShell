import { Stack } from "expo-router/stack";
import { largeTitleHeader } from "@/components/headers";

export default function ProjectsStack() {
  return (
    <Stack screenOptions={largeTitleHeader}>
      <Stack.Screen name="index" options={{ title: "项目", headerShown: false }} />
      <Stack.Screen name="detail" options={{ title: "", headerLargeTitleEnabled: false }} />
    </Stack>
  );
}
