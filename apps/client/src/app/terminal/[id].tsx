import { adaptiveScreen } from "@/components/adaptive-page";
import { TerminalScreen } from "@/screens/terminal-screen";

export default adaptiveScreen(TerminalScreen, { surface: "plain" });
