import { Image } from "expo-image";
import { View } from "react-native";
import type { ComputerProfile } from "@/lib/computers";

const art = {
  notebook: require("../../assets/computers/notebook.webp"),
  mini: require("../../assets/computers/mini.webp"),
  tower: require("../../assets/computers/tower.webp"),
  computer: require("../../assets/computers/computer.png"),
};
const proportions = { notebook: [0.84, 1], mini: [0.68, 0.72], tower: [0.98, 0.98], computer: [0.78, 0.88] } as const;

export function ComputerArt({
  profile,
  width = 68,
  height = 54,
}: {
  profile?: ComputerProfile;
  width?: number;
  height?: number;
}) {
  const kind =
    profile?.formFactor === "mac-mini"
      ? "mini"
      : profile?.formFactor === "notebook"
        ? "notebook"
        : profile?.platform === "win32" && (profile.formFactor === "tower" || profile.formFactor === "desktop")
          ? "tower"
          : "computer";
  const [w, h] = proportions[kind];
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width, height, maxWidth: "100%", alignItems: "center", justifyContent: "center" }}
    >
      <Image
        accessible={false}
        recyclingKey={kind}
        source={art[kind]}
        contentFit="contain"
        style={{ width: `${w * 100}%`, height: `${h * 100}%` }}
      />
    </View>
  );
}
