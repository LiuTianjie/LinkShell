import { adaptiveScreen } from "@/components/adaptive-page";
import { SideScreen } from "@/screens/side-screen";

export default adaptiveScreen(SideScreen, { maxWidth: 680, surface: "sheet" });
