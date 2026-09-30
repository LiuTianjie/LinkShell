import { ActivityIndicator, Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Button } from "./button";
import { Icon, type IconProps } from "./icon";

export function LoadingState({ label }: { label?: string }) {
  return (
    <View style={{ paddingVertical: 64, alignItems: "center", gap: 12 }}>
      <ActivityIndicator color={colors.secondaryLabel} />
      {label ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: Pick<IconProps, "sf" | "md">;
  title: string;
  message?: string;
  action?: { title: string; onPress: () => void };
}) {
  return (
    <View style={{ paddingVertical: 56, paddingHorizontal: 32, alignItems: "center", gap: 10 }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 20,
          borderCurve: "continuous",
          backgroundColor: colors.fill,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 4,
        }}
      >
        <Icon {...icon} size={28} color={colors.secondaryLabel} />
      </View>
      <Text style={[type.headline, { color: colors.label, textAlign: "center" }]}>{title}</Text>
      {message ? (
        <Text selectable style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center", maxWidth: 300 }]}>
          {message}
        </Text>
      ) : null}
      {action ? <Button title={action.title} onPress={action.onPress} variant="tonal" style={{ marginTop: 8 }} /> : null}
    </View>
  );
}
