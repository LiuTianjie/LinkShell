import { adaptiveScreen } from "@/components/adaptive-page";
import { PortsScreen } from "@/screens/ports-screen";

export default adaptiveScreen(PortsScreen, { maxWidth: 680, surface: "sheet" });
