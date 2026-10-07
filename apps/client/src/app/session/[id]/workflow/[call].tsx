import { adaptiveScreen } from "@/components/adaptive-page";
import { WorkflowScreen } from "@/screens/workflow-screen";

export default adaptiveScreen(WorkflowScreen, { maxWidth: 1000, surface: "background" });
