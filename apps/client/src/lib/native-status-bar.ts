import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

// A JS update can reach an older binary before its per-controller setting exists.
export const nativeStatusBar = Platform.OS === "ios" && requireOptionalNativeModule("LinkLayout")?.viewControllerStatusBarAppearance === true;
