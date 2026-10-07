import { adaptiveScreen } from "@/components/adaptive-page";
import { ProjectDetailScreen } from "@/screens/project-detail-screen";

export default adaptiveScreen(ProjectDetailScreen, { maxWidth: 1000, surface: "background" });
