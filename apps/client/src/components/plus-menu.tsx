import type { MenuAction } from "@react-native-menu/menu";
import { AppMenu } from "@/components/app-menu";
import { View } from "react-native";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";

export interface PlusMenuProps {
  canAttachImages: boolean;
  canAttachAudio?: boolean;
  canAttachFiles?: boolean;
  /** The agent has slash commands to offer. */
  hasCommands: boolean;
  onPickPhoto: () => void;
  onTakePhoto: () => void;
  /** Opens the command picker. */
  onCommands: () => void;
  onPickAudio?: () => void;
  onPickFile?: () => void;
  disabled?: boolean;
}

/** The composer's "+": photos, camera and the agent's slash commands. */
export function PlusMenu({ canAttachImages, canAttachAudio, canAttachFiles, hasCommands, onPickPhoto, onTakePhoto, onPickAudio, onPickFile, onCommands, disabled }: PlusMenuProps) {
  const actions: MenuAction[] = [
    ...(canAttachImages
      ? [
          { id: "photo", title: "照片", image: "photo.on.rectangle" },
          { id: "camera", title: "拍照", image: "camera" },
        ]
      : []),
    // A sheet with a search field, not a submenu: an agent can have over a hundred.
    ...(hasCommands ? [{ id: "commands", title: "命令", image: "command" }] : []),
    ...(canAttachAudio ? [{ id: "audio", title: "音频文件", image: "waveform" }] : []),
    ...(canAttachFiles ? [{ id: "file", title: "文件内容", image: "doc" }] : []),
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
        else if (id === "audio") onPickAudio?.();
        else if (id === "file") onPickFile?.();
      }}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel="添加"
        pointerEvents={disabled ? "none" : "auto"}
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
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
