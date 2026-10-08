import { adaptiveScreen } from "@/components/adaptive-page";
import { WorkflowsScreen } from "@/screens/workflow-screen";

export default adaptiveScreen(WorkflowsScreen, { maxWidth: 1000, surface: "plain" });
