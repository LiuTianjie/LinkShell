import type { ComponentType } from "react";

// Dev-only: an isolated screen server can exercise the native pipeline without pairing or
// modifying a user's computer list. The implementation is absent from release bundles.
const Screen: ComponentType = __DEV__ ? require("@/dev/native-screen-test").NativeScreenTest : () => null;
export default Screen;
