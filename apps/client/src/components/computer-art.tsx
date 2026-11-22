import { Image } from "expo-image";
import { View } from "react-native";
import { computerIllustrationKind, type ComputerIllustrationKind } from "@/lib/computer-profile";
import type { ComputerProfile } from "@/lib/computers";
import { useComputerArtwork } from "@/lib/use-computer-artwork";

export { computerIllustrationKind };

const art: Record<ComputerIllustrationKind, number> = {
  air: require("../../assets/computers/air.webp"),
  notebook: require("../../assets/computers/notebook.webp"),
  studio: require("../../assets/computers/studio.webp"),
  mini: require("../../assets/computers/mini.webp"),
  tower: require("../../assets/computers/tower.webp"),
  allInOne: require("../../assets/computers/computer.png"),
  generic: require("../../assets/computers/generic.webp"),
};

const proportions: Record<ComputerIllustrationKind, number> = {
  air: 0.9,
  notebook: 0.86,
  studio: 0.72,
  mini: 0.68,
  tower: 0.96,
  allInOne: 0.78,
  generic: 0.86,
};

const heightScale: Partial<Record<ComputerIllustrationKind, number>> = {
  studio: 0.84,
  mini: 0.72,
  allInOne: 0.94,
  generic: 0.94,
};

export function ComputerArt({ profile, width = 68, height = 54 }: { profile?: ComputerProfile; width?: number; height?: number }) {
  const kind = computerIllustrationKind(profile);
  const official = useComputerArtwork(profile?.hardwareModel?.artworkId);
  const w = width * proportions[kind];
  const h = height * (heightScale[kind] ?? 1);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width, height, maxWidth: "100%", alignItems: "center", justifyContent: "center" }}
    >
      {official ? (
        <Image
          accessible={false}
          recyclingKey={profile?.hardwareModel?.artworkId}
          source={{ uri: official }}
          contentFit="contain"
          style={{ width: width * (kind === "mini" ? 0.7 : kind === "studio" ? 0.74 : 0.94), height: height * 0.92 }}
        />
      ) : (
        <Image
          accessible={false}
          recyclingKey={kind}
          source={art[kind]}
          contentFit="contain"
          style={{ width: w, height: h }}
        />
      )}
    </View>
  );
}
