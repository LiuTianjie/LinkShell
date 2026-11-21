import { adaptiveScreen } from "@/components/adaptive-page";
import { McpAppScreen } from "@/screens/mcp-app-screen";

export default adaptiveScreen(McpAppScreen, { surface: "plain" });
