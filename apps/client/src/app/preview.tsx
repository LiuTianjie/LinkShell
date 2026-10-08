import { adaptiveScreen } from "@/components/adaptive-page";
import { PreviewScreen } from "@/screens/preview-screen";

export default adaptiveScreen(PreviewScreen, { surface: "plain" });
