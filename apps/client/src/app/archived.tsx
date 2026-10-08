import { adaptiveScreen } from "@/components/adaptive-page";
import { ArchivedScreen } from "@/screens/archived-screen";

export default adaptiveScreen(ArchivedScreen, { maxWidth: 840, surface: "background" });
