import { adaptiveScreen } from "@/components/adaptive-page";
import { ConnectScreen } from "@/screens/connect-screen";

export default adaptiveScreen(ConnectScreen, { maxWidth: 600, surface: "sheet" });
