import { adaptiveScreen } from "@/components/adaptive-page";
import { UnlockScreen } from "@/screens/unlock-screen";

export default adaptiveScreen(UnlockScreen, { maxWidth: 600, surface: "sheet" });
