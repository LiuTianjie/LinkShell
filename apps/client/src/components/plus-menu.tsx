import type { MenuAction } from "@react-native-menu/menu";
import { AppMenu } from "@/components/app-menu";
import { View } from "react-native";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";

export interface PlusMenuProps {
  canAttachImages: boolean;
  /** The agent has slash commands to offer. */
  hasCommands: boolean;
  onPickPhoto: () => void;
  onTakePhoto: () => void;
  /** Opens the command picker. */
  onCommands: () => void;
  disabled?: boolean;
}

/** The composer's "+": photos, camera and the agent's slash commands. */
export function PlusMenu({ canAttachImages, hasCommands, onPickPhoto, onTakePhoto, onCommands, disabled }: PlusMenuProps) {
  const actions: MenuAction[] = [
    ...(canAttachImages
      ? [
          { id: "photo", title: "照片", image: "photo.on.rectangle" },
          { id: "camera", title: "拍照", image: "camera" },
        ]
      : []),
    // A sheet with a search field, not a submenu: an agent can have over a hundred.
    ...(hasCommands ? [{ id: "commands", title: "命令", image: "command" }] : []),
  ];
  return (
    <AppMenu
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id === "photo") onPickPhoto();
        else if (id === "camera") onTakePhoto();
        else if (id === "commands") onCommands();
      }}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel="添加"
        pointerEvents={disabled ? "none" : "auto"}
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: colors.fill,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Icon sf="plus" md="add" size={15} weight="medium" />
      </View>
    </AppMenu>
  );
}
