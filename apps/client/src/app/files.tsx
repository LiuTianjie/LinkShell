import { adaptiveScreen } from "@/components/adaptive-page";
import { FilesScreen } from "@/screens/files-screen";

export default adaptiveScreen(FilesScreen, { surface: "background" });
