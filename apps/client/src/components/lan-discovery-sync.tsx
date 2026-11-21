import { useForegroundLanDiscovery } from "@/lib/lan-discovery-native";

/** Root-level foreground mDNS discovery coordinator so computer reachability hints stay current. */
export function LanDiscoverySync() {
  useForegroundLanDiscovery();
  return null;
}
