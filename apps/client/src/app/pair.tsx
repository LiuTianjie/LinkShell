import { adaptiveScreen } from "@/components/adaptive-page";
import { PairScreen } from "@/screens/pair-screen";

export default adaptiveScreen(PairScreen, { maxWidth: 600, surface: "sheet" });
