import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Platform } from "react-native";
import { FloatingTabs } from "@/components/floating-tabs";
import { useClient } from "@/lib/client";
import { colors } from "@/theme/colors";

function useWaitingCount(): number {
  return useClient((state) => {
    let count = 0;
    for (const session of Object.values(state.sessions)) if (!session.archived && session.state === "waiting") count++;
    return count;
  });
}

export default function TabsLayout() {
  const waiting = useWaitingCount();
  // iOS gets the system's liquid glass tab bar; elsewhere a matching floating capsule.
  if (Platform.OS !== "ios") {
    return (
      <FloatingTabs
        tabs={[
          { name: "(home)", href: "/", label: "首页", icon: { sf: "tray", md: "inbox" }, badge: waiting },
          { name: "projects", href: "/projects", label: "项目", icon: { sf: "folder", md: "folder" } },
          { name: "computer", href: "/computer", label: "电脑", icon: { sf: "laptopcomputer", md: "laptop_mac" } },
        ]}
      />
    );
  }
  return (
    <NativeTabs tintColor={colors.accent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} md="inbox" />
        <NativeTabs.Trigger.Label>首页</NativeTabs.Trigger.Label>
        {waiting > 0 ? <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Icon sf={{ default: "folder", selected: "folder.fill" }} md="folder" />
        <NativeTabs.Trigger.Label>项目</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computer">
        <NativeTabs.Trigger.Icon sf="laptopcomputer" md="laptop_mac" />
        <NativeTabs.Trigger.Label>电脑</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
