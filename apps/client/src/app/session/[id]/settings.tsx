import { adaptiveScreen } from "@/components/adaptive-page";
import { SessionSettingsScreen } from "@/screens/session-settings-screen";

export default adaptiveScreen(SessionSettingsScreen, { maxWidth: 680, surface: "sheet" });
