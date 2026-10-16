import { adaptiveScreen } from "@/components/adaptive-page";
import { RenameComputerScreen } from "@/screens/rename-computer-screen";

export default adaptiveScreen(RenameComputerScreen, { maxWidth: 600, surface: "sheet" });
