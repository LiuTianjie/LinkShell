import { MaterialCommunityIcons } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import React from "react";

const FALLBACK_ICONS: Record<string, React.ComponentProps<typeof MaterialCommunityIcons>["name"]> = {
  "app.badge.fill": "apps",
  "apple.logo": "apple",
  "arrow.clockwise": "refresh",
  "arrow.counterclockwise.circle.fill": "backup-restore",
  "arrow.down.right.and.arrow.up.left": "arrow-collapse",
  "arrow.up": "arrow-up",
  "arrow.up.forward.app": "open-in-new",
  "arrow.up.left.and.arrow.down.right": "arrow-expand",
  "bubble.left.and.text.bubble.right": "message-text-outline",
  "camera.fill": "camera",
  "checkmark.circle.fill": "check-circle",
  "chevron.left": "chevron-left",
  "chevron.right": "chevron-right",
  circle: "circle-outline",
  clock: "clock-outline",
  desktopcomputer: "monitor",
  "doc.text": "file-document-outline",
  "exclamationmark.triangle.fill": "alert",
  "eye.fill": "eye",
  "folder.badge.plus": "folder-plus",
  "folder.fill": "folder",
  "gearshape.fill": "cog",
  globe: "web",
  "hand.raised": "hand-back-right-outline",
  "hand.raised.fill": "hand-back-right",
  "house.fill": "home",
  iphone: "cellphone",
  keyboard: "keyboard-outline",
  "keyboard.chevron.compact.down": "keyboard-close",
  "list.bullet.rectangle.fill": "format-list-bulleted-square",
  "lock.shield.fill": "shield-lock",
  "lock.open.fill": "lock-open-variant",
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
  sparkles: "creation",
  "square.grid.2x2": "view-grid-outline",
  "paperplane.fill": "send",
  "stop.circle.fill": "stop-circle",
  "terminal.fill": "console",
  "textformat.size.larger": "plus",
  "textformat.size.smaller": "minus",
  "trash.fill": "delete",
  tray: "tray",
  "wifi.slash": "wifi-off",
  xmark: "close",
  "xmark.circle": "close-circle-outline",
  "xmark.circle.fill": "close-circle",
  "ellipsis.circle": "dots-horizontal-circle-outline",
  "arrow.counterclockwise": "refresh",
  "magnifyingglass": "magnify",
  "plus.magnifyingglass": "magnify-plus-outline",
  "minus.magnifyingglass": "magnify-minus-outline",
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
