import { adaptiveScreen } from "@/components/adaptive-page";
import { RenameScreen } from "@/screens/rename-screen";

export default adaptiveScreen(RenameScreen, { maxWidth: 600, surface: "sheet" });
