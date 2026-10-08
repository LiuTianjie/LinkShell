import { adaptiveScreen } from "@/components/adaptive-page";
import { CommandsScreen } from "@/screens/commands-screen";

export default adaptiveScreen(CommandsScreen, { maxWidth: 680, surface: "sheet" });
