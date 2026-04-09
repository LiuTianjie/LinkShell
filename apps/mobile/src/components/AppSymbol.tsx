import { MaterialCommunityIcons } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import React from "react";

const FALLBACK_ICONS: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>["name"]> = {
  "app.badge.fill": "apps",
  "apple.logo": "apple",
  "arrow.counterclockwise.circle.fill": "backup-restore",
  "camera.fill": "camera",
  "chevron.left": "chevron-left",
  "chevron.right": "chevron-right",
  clock: "clock-outline",
  desktopcomputer: "monitor",
  "exclamationmark.triangle.fill": "alert",
  "folder.fill": "folder",
  "gearshape.fill": "cog",
  "hand.raised": "hand-back-right-outline",
  "hand.raised.fill": "hand-back-right",
  "house.fill": "home",
  iphone: "cellphone",
  keyboard: "keyboard-outline",
  "keyboard.chevron.compact.down": "keyboard-close",
  "list.bullet.rectangle.fill": "format-list-bulleted-square",
  "lock.shield.fill": "shield-lock",
  "mic.fill": "microphone",
  "mic.slash.fill": "microphone-off",
  "moon.fill": "moon-waning-crescent",
  pc: "microsoft-windows",
  photo: "image-outline",
  plus: "plus",
  "plus.circle.fill": "plus-circle",
  power: "power",
  "qrcode.viewfinder": "qrcode-scan",
  "questionmark.circle.fill": "help-circle",
  "rectangle.on.rectangle": "picture-in-picture-bottom-right-outline",
  "server.rack": "server",
  "square.grid.2x2": "view-grid-outline",
  "terminal.fill": "console",
  "textformat.size.larger": "plus",
  "textformat.size.smaller": "minus",
  "trash.fill": "delete",
  tray: "tray",
  "wifi.slash": "wifi-off",
  xmark: "close",
  "xmark.circle": "close-circle-outline",
  "xmark.circle.fill": "close-circle",
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