import { adaptiveScreen } from "@/components/adaptive-page";
import { ChangesScreen } from "@/screens/changes-screen";

export default adaptiveScreen(ChangesScreen, { maxWidth: 1000, surface: "background" });
