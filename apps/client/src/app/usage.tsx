import { adaptiveScreen } from "@/components/adaptive-page";
import { UsageScreen } from "@/screens/usage-screen";

export default adaptiveScreen(UsageScreen, { maxWidth: 900, surface: "background" });
