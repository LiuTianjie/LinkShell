import { useRef, type ReactNode } from "react";
import { Alert, Pressable, type ColorValue } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated from "react-native-reanimated";
import { Text } from "@/components/fixed-text";
import { Icon } from "@/components/icon";
import { GatewayUnreachable, useComputers, type Computer } from "@/lib/computers";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/** Whether this computer can be taken off the list: one online and signed in to the account would only come straight back. */
export function computerRemovable(computer: Computer, online: boolean | undefined): boolean {
  return !(computer.kind === "relay" && computer.machine.via === "account" && online);
}

/** Asks before removing; `done` runs either way once the alert is answered. */
export function confirmRemoveComputer(computer: Computer, name: string, done?: () => void) {
  const viaAccount = computer.kind === "relay" && computer.machine.via === "account";
  Alert.alert(
    `移除「${name}」？`,
    viaAccount ? "它会从你的账号下移除。如果这台电脑以后重新上线并登录同一账号，会再次出现。" : computer.kind === "direct" ? "之后可以重新添加这台电脑的局域网地址。" : "之后要重新配对才能连接。",
    [
      { text: "取消", style: "cancel", onPress: done },
      {
        text: "移除",
        style: "destructive",
        onPress: () =>
          void useComputers
            .getState()
            .remove(computer.key)
            .then(
              (removed) => {
                if (!removed) Alert.alert("没能移除", "这个网关的版本还不支持移除同一账号下的电脑，升级网关后再试。");
              },
              (reason: unknown) => {
                if (!(reason instanceof GatewayUnreachable)) {
                  Alert.alert("没能移除", "这台电脑还在列表里，请稍后再试。");
                  return;
                }
                Alert.alert("现在连不上网关", "解除配对要经过网关，这台电脑还在列表里。可以联网后再试；如果这个网关已经不用了，也可以只从这台手机移除。", [
                  { text: "好", style: "cancel" },
                  { text: "只从这台手机移除", style: "destructive", onPress: () => void useComputers.getState().remove(computer.key, { localOnly: true }).catch(() => {}) },
                ]);
              },
            )
            .finally(done),
      },
    ],
    { cancelable: true, onDismiss: done },
  );
}

/**
 * A computer's row that swipes left to 移除, like a system list. `children` gets `remove` so the
 * row's own button can offer the same to VoiceOver, which cannot swipe a row open.
 */
export function ComputerSwipe({ computer, name, enabled, background, children }: {
  computer: Computer;
  name: string;
  enabled: boolean;
  background: ColorValue;
  children: (remove?: () => void) => ReactNode;
}) {
  const swipe = useRef<SwipeableMethods>(null);
  if (!enabled) return <>{children(undefined)}</>;
  const remove = () => {
    haptics.selection();
    confirmRemoveComputer(computer, name, () => swipe.current?.close());
  };
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      dragOffsetFromRightEdge={12}
      containerStyle={{ backgroundColor: colors.danger }}
      childrenContainerStyle={{ backgroundColor: background }}
      renderRightActions={() => (
        <Animated.View style={{ width: 84 }}>
          <Pressable
            onPress={remove}
            accessibilityRole="button"
            accessibilityLabel={`移除 ${name}`}
            style={({ pressed }) => ({ flex: 1, alignItems: "center", justifyContent: "center", gap: 4, opacity: pressed ? 0.6 : 1 })}
          >
            {/* `plain` is white on the light red and black on the lighter dark-mode red: readable on both. */}
            <Icon sf="trash" md="delete" size={17} color={colors.plain} />
            <Text style={[type.caption, { color: colors.plain, fontWeight: "600" }]}>移除</Text>
          </Pressable>
        </Animated.View>
      )}
    >
      {children(remove)}
    </ReanimatedSwipeable>
  );
}
