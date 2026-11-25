import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PortsScreen } from "@/screens/ports-screen";
import { colors } from "@/theme/colors";

// `fitToContents` form sheets must not wrap children in a `flex: 1` AdaptivePage container.
export default function PortsRoute() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: colors.sheet, paddingLeft: insets.left, paddingRight: insets.right }}>
      <View style={{ width: "100%", maxWidth: 680, alignSelf: "center" }}>
        <PortsScreen />
      </View>
    </View>
  );
}
