import { adaptiveScreen } from "@/components/adaptive-page";
import { NewSessionScreen } from "@/screens/new-session-screen";

export default adaptiveScreen(NewSessionScreen, { maxWidth: 680, surface: "sheet" });
