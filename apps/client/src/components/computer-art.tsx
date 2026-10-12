import { Image } from "expo-image";
import { useColorScheme, View } from "react-native";

const artwork = {
  laptop: require("../../assets/computers/laptop.png"),
  mini: require("../../assets/computers/mini.png"),
  computer: require("../../assets/computers/computer.png"),
};

export function ComputerArt({ name, size = 42 }: { name: string; size?: number }) {
  const dark = useColorScheme() === "dark";
  // Names are a visual hint, not hardware metadata; unknown machines stay generic.
  const kind = /mac[\s_-]*mini|迷你主机/i.test(name) ? "mini"
    : /macbook|laptop|notebook|笔记本/i.test(name) ? "laptop" : "computer";
  return (
    <View accessible={false} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: dark ? "#484b53" : "#e6e7eb", alignItems: "center", justifyContent: "center" }}>
      <Image source={artwork[kind]} contentFit="contain" accessible={false} style={{ width: size * 0.54, height: size * 0.54 }} />
    </View>
  );
}
