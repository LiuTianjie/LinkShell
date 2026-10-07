import { adaptiveScreen } from "@/components/adaptive-page";
import { WorkflowAgentScreen } from "@/screens/subagent-screen";

export default adaptiveScreen(WorkflowAgentScreen, { maxWidth: 900, surface: "plain" });
