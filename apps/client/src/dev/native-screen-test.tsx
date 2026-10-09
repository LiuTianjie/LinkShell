import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { NativeScreenPane } from "@/components/native-screen-pane";
import { Text } from "@/components/fixed-text";
import type { ScreenMode, ScreenWidth } from "@/lib/settings";

/** Simulator harness for packages/host/scripts/screen-dev.ts; all input should be dry-run. */
export function NativeScreenTest() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  const [mode, setMode] = useState<ScreenMode>("view");
  const [width, setWidth] = useState<ScreenWidth>("1920");
  const [full, setFull] = useState(false);
  const { height } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-height.value, 0) }));
  const address = url && `${url}&width=${width}`;
  return <Animated.View style={[{ flex: 1, backgroundColor: "#000" }, lift]}>
    <Stack.Screen options={{ title: "原生屏幕验证", headerShown: !full }} />
    {address ? <NativeScreenPane key={address} url={address} mode={mode} onMode={setMode} width={width} onWidth={setWidth} shortcuts={[]} fullscreen={full} onFullscreen={() => setFull((value) => !value)} canRotate={false} onRotate={() => {}} onCompatibility={() => {}} top={0} bottom={20} left={0} right={0} /> : <Text>需要本机屏幕测试地址</Text>}
  </Animated.View>;
}
