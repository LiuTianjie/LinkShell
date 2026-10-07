import { adaptiveScreen } from "@/components/adaptive-page";
import { SubagentScreen } from "@/screens/subagent-screen";

export default adaptiveScreen(SubagentScreen, { maxWidth: 900, surface: "plain" });
