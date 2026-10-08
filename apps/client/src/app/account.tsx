import { adaptiveScreen } from "@/components/adaptive-page";
import { AccountScreen } from "@/screens/account-screen";

export default adaptiveScreen(AccountScreen, { maxWidth: 1100, surface: "background" });
