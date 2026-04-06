import React from "react";
import { Animated, Dimensions, StyleSheet } from "react-native";
import { useRef, useState } from "react";
import { useAppContext } from "../../contexts/AppContext";
import { SettingsScreen } from "../../screens/SettingsScreen";
import { GatewayListScreen } from "../../screens/GatewayListScreen";

export default function SettingsTab() {
  const ctx = useAppContext();
  const [gatewayListVisible, setGatewayListVisible] = useState(false);
  const gatewaySlideAnim = useRef(new Animated.Value(Dimensions.get("window").width)).current;

  const openGatewayList = () => {
    setGatewayListVisible(true);
    gatewaySlideAnim.setValue(Dimensions.get("window").width);
    Animated.timing(gatewaySlideAnim, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  };

  const closeGatewayList = (cb?: () => void) => {
    Animated.timing(gatewaySlideAnim, {
      toValue: Dimensions.get("window").width,
      duration: 300,
      useNativeDriver: true,
    }).start(() => {
      setGatewayListVisible(false);
      ctx.setSessionRefreshKey((k) => k + 1);
      cb?.();
    });
  };

  return (
    <>
      <SettingsScreen
        gatewayBaseUrl={ctx.gatewayBaseUrl}
        onGatewayChange={ctx.setGatewayBaseUrl}
        onOpenGatewayList={openGatewayList}
      />
      {gatewayListVisible ? (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: gatewaySlideAnim }] }]}>
          <GatewayListScreen
            onBack={() => closeGatewayList()}
            onAddGateway={() => closeGatewayList(() => ctx.setConnectionSheetVisible(true))}
            onGatewayChange={ctx.setGatewayBaseUrl}
          />
        </Animated.View>
      ) : null}
    </>
  );
}
