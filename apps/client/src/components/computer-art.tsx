import { Image } from "expo-image";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import type { ComputerProfile } from "@/lib/computers";
import { useComputerArtwork } from "@/lib/use-computer-artwork";
import { computerIllustrations } from "./computer-illustrations";

const art = {
  notebook: require("../../assets/computers/notebook.webp"),
  mini: require("../../assets/computers/mini.webp"),
  tower: require("../../assets/computers/tower.webp"),
  allInOne: require("../../assets/computers/computer.png"),
};

function illustration(profile?: ComputerProfile) {
  switch (profile?.hardwareModel?.family) {
    case "MacBook Air": return "air";
    case "MacBook Pro": return "pro";
    case "Mac Studio": return "studio";
  }
  switch (profile?.formFactor) {
    case "mac-mini": return "mini";
    case "notebook": return "notebook";
    case "all-in-one": return "allInOne";
    case "tower": if (profile.platform === "win32") return "tower";
  }
  return "unknown";
}

const proportions = { air: .94, pro: .94, studio: .78, notebook: .84, mini: .68, tower: .98, allInOne: .78, unknown: .9 };
export function ComputerArt({ profile, width = 68, height = 54 }: { profile?: ComputerProfile; width?: number; height?: number }) {
  const kind = illustration(profile);
  const official = useComputerArtwork(profile?.hardwareModel?.artworkId);
  const w = width * proportions[kind];
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width, height, maxWidth: "100%", alignItems: "center", justifyContent: "center" }}>
      {official ? (
        <Image accessible={false} recyclingKey={profile?.hardwareModel?.artworkId} source={{ uri: official }} contentFit="contain"
          style={{ width: width * (kind === "mini" ? .70 : .94), height: height * .92 }} />
      ) : kind === "air" || kind === "pro" || kind === "studio" || kind === "unknown" ? (
        <SvgXml xml={computerIllustrations[kind]} width={w} height={height} />
      ) : (
        <Image accessible={false} recyclingKey={kind} source={art[kind]} contentFit="contain" style={{ width: w, height: kind === "mini" ? height * .72 : height }} />
      )}
    </View>
  );
}
