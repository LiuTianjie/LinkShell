import { NativeTabs, Label, Icon, VectorIcon } from "expo-router/unstable-native-tabs";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";

export default function TabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon
          sf={{ default: "house", selected: "house.fill" }}
          androidSrc={<VectorIcon family={MaterialCommunityIcons} name="home" />}
        />
        <Label>首页</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sessions">
        <Icon
          sf={{ default: "list.bullet.rectangle", selected: "list.bullet.rectangle.fill" }}
          androidSrc={<VectorIcon family={MaterialCommunityIcons} name="format-list-bulleted-square" />}
        />
        <Label>会话</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agent">
        <Icon
          sf={{ default: "sparkles", selected: "sparkles" }}
          androidSrc={<VectorIcon family={MaterialCommunityIcons} name="creation" />}
        />
        <Label>Agent</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
          androidSrc={<VectorIcon family={MaterialCommunityIcons} name="cog" />}
        />
        <Label>设置</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
