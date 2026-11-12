import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Platform } from "react-native";
import { FloatingTabs } from "@/components/floating-tabs";
import { useClient } from "@/lib/client";
import { useLocale } from "@/lib/locale";
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
  const { t } = useLocale();
  const sessionsLabel = t("nav.sessions");
  const projectsLabel = t("nav.projects");
  const computerLabel = t("nav.computers");
  // iOS gets the system's liquid glass tab bar; elsewhere a matching floating capsule.
  if (Platform.OS !== "ios") {
    return (
      <FloatingTabs
        tabs={[
          { name: "(home)", href: "/", label: sessionsLabel, icon: { sf: "tray", md: "inbox" }, badge: waiting },
          { name: "projects", href: "/projects", label: projectsLabel, icon: { sf: "square.stack.3d.up", md: "stacks" } },
          { name: "computer", href: "/computer", label: computerLabel, icon: { sf: "laptopcomputer", md: "laptop_mac" } },
        ]}
      />
    );
  }
  return (
    // The badge counts sessions waiting on the user, so it is their amber, not the system red.
    <NativeTabs tintColor={colors.accent} badgeBackgroundColor={colors.waitingFill} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} md="inbox" />
        <NativeTabs.Trigger.Label>{sessionsLabel}</NativeTabs.Trigger.Label>
        {waiting > 0 ? <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Icon sf={{ default: "square.stack.3d.up", selected: "square.stack.3d.up.fill" }} md="stacks" />
        <NativeTabs.Trigger.Label>{projectsLabel}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computer">
        <NativeTabs.Trigger.Icon sf="laptopcomputer" md="laptop_mac" />
        <NativeTabs.Trigger.Label>{computerLabel}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
