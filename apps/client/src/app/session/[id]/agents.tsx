import { adaptiveScreen } from "@/components/adaptive-page";
import { SubagentsScreen } from "@/screens/subagents-screen";

export default adaptiveScreen(SubagentsScreen, { maxWidth: 760, surface: "sheet" });
