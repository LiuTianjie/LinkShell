import { MaterialCommunityIcons } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import React from "react";

const FALLBACK_ICONS: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>["name"]> = {
  "app.badge.fill": "apps",
  "arrow.counterclockwise.circle.fill": "backup-restore",
  "camera.fill": "camera",
  "chevron.right": "chevron-right",
  clock: "clock-outline",
  "exclamationmark.triangle.fill": "alert",
  "gearshape.fill": "cog",
  "hand.raised": "hand-back-right-outline",
  "hand.raised.fill": "hand-back-right",
  "house.fill": "home",
  iphone: "cellphone",
  keyboard: "keyboard-outline",
  "list.bullet.rectangle.fill": "format-list-bulleted-square",
  "moon.fill": "moon-waning-crescent",
  "plus.circle.fill": "plus-circle",
  "qrcode.viewfinder": "qrcode-scan",
  "server.rack": "server",
  "terminal.fill": "console",
  "textformat.size.larger": "plus",
  "textformat.size.smaller": "minus",
  tray: "tray",
  xmark: "close",
  "xmark.circle.fill": "close-circle",
  "mic.fill": "microphone",
  "mic.slash.fill": "microphone-off",
  "rectangle.on.rectangle": "picture-in-picture-bottom-right-outline",
  "square.grid.2x2": "view-grid-outline",
  "keyboard.chevron.compact.down": "keyboard-close",
  "photo": "image-outline",
  plus: "plus",
};

interface AppSymbolProps {
  name: string;
  size: number;
  color: string;
  style?: React.ComponentProps<typeof SymbolView>["style"];
}

export function AppSymbol({ name, size, color, style }: AppSymbolProps) {
  return (
    <SymbolView
      name={name as never}
      size={size}
      tintColor={color}
      style={style}
      fallback={
        <MaterialCommunityIcons
          name={FALLBACK_ICONS[name] ?? "help-circle-outline"}
          size={size}
          color={color}
          style={style as React.ComponentProps<typeof MaterialCommunityIcons>["style"]}
        />
      }
    />
  );
}