import { adaptiveScreen } from "@/components/adaptive-page";
import { ProjectsScreen } from "@/screens/projects-screen";

export default adaptiveScreen(ProjectsScreen, { maxWidth: 1100, surface: "background" });
