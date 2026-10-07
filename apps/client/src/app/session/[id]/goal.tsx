import { adaptiveScreen } from "@/components/adaptive-page";
import { GoalScreen } from "@/screens/goal-screen";

export default adaptiveScreen(GoalScreen, { maxWidth: 680, surface: "sheet" });
