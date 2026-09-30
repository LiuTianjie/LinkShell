import type { ComponentType } from "react";

// Dev-only route; the fixture and screen are stripped from release bundles.
const Screen: ComponentType = __DEV__ ? require("@/dev/gallery-screen").GalleryScreen : () => null;
export default Screen;
