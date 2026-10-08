import { adaptiveScreen } from "@/components/adaptive-page";
import { BrowseScreen } from "@/screens/browse-screen";

export default adaptiveScreen(BrowseScreen, { maxWidth: 680, surface: "sheet" });
