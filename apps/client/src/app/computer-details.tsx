import { adaptiveScreen } from "@/components/adaptive-page";
import { ComputerDetailsScreen } from "@/screens/computer-details-screen";

export default adaptiveScreen(ComputerDetailsScreen, { maxWidth: 720, surface: "sheet" });
