import { adaptiveScreen } from "@/components/adaptive-page";
import { ComputerScreen } from "@/screens/computer-screen";

export default adaptiveScreen(ComputerScreen, { maxWidth: 1100, surface: "background" });
