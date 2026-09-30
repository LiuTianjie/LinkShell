import { Stack } from "expo-router/stack";
import { largeTitleHeader } from "@/components/headers";

export default function ComputerStack() {
  return (
    <Stack screenOptions={largeTitleHeader}>
      <Stack.Screen name="index" options={{ title: "电脑", headerShown: false }} />
    </Stack>
  );
}
