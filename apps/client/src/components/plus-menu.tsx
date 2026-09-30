import type { MenuAction } from "@react-native-menu/menu";
import { AppMenu } from "@/components/app-menu";
import { View } from "react-native";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";

export interface PlusMenuProps {
  canAttachImages: boolean;
  commands: { name: string; description: string }[];
  onPickPhoto: () => void;
  onTakePhoto: () => void;
  onCommand: (name: string) => void;
  disabled?: boolean;
}

/** The composer's "+": photos, camera and the agent's slash commands. */
export function PlusMenu({ canAttachImages, commands, onPickPhoto, onTakePhoto, onCommand, disabled }: PlusMenuProps) {
  const actions: MenuAction[] = [
    ...(canAttachImages
      ? [
          { id: "photo", title: "照片", image: "photo.on.rectangle" },
          { id: "camera", title: "拍照", image: "camera" },
        ]
      : []),
    ...(commands.length
      ? [
          {
            id: "commands",
            title: "命令",
            image: "command",
            subactions: commands.slice(0, 40).map((command) => ({
              id: `cmd:${command.name}`,
              title: `/${command.name}`,
              subtitle: command.description || undefined,
            })),
          },
        ]
      : []),
  ];
  return (
    <AppMenu
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id === "photo") onPickPhoto();
        else if (id === "camera") onTakePhoto();
        else if (id.startsWith("cmd:")) onCommand(id.slice(4));
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
