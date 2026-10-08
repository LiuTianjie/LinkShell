import type { ComponentType } from "react";
import { adaptiveScreen } from "@/components/adaptive-page";

// Dev-only route; the fixture and screen are stripped from release bundles.
const Screen: ComponentType = __DEV__ ? require("@/dev/gallery-screen").GalleryScreen : () => null;
export default adaptiveScreen(Screen, { surface: "plain" });
