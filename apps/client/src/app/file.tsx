import { adaptiveScreen } from "@/components/adaptive-page";
import { FileScreen } from "@/screens/file-screen";

export default adaptiveScreen(FileScreen, { surface: "code" });
