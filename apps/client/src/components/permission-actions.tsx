import type { PermissionOption } from "@linkshell/wire";
import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { permissionChoices, type PermissionChoice } from "@/lib/describe";
import { haptics } from "@/lib/haptics";
import { describeActionError } from "@/lib/locale";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Button } from "./button";

/**
 * Reject / allow buttons for a permission request, plus the less common
 * choices as quieter buttons after them: 拒绝 → 允许 → 始终允许 → 停止, the
 * order every end uses. Only 允许 is filled; nothing is red, so a refusal
 * never reads as the dangerous choice. Resolves itself when the host reports
 * the answer (from here or from the computer).
 */
export function PermissionActions({
  options,
  onChoose,
  disabled = false,
  size = "medium",
  maxExtra = 2,
  compact = false,
}: {
  options: PermissionOption[];
  onChoose: (optionId: string) => Promise<void>;
  disabled?: boolean;
  size?: "medium" | "large";
  maxExtra?: number;
  compact?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const stacked = width > 0 && (width < 300 || fontScale > 1.3);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = permissionChoices(options);
  // Some ACP agents only offer a stop/cancel choice. Never hide their sole denial.
  const reject = choices.find((c) => c.role === "reject") ?? choices.find((c) => c.role === "stop");
  const allow = choices.find((c) => c.role === "allow");
  const main = [reject, allow].filter((c): c is PermissionChoice => !!c);
  const extra = choices.filter((c) => !main.includes(c)).slice(0, maxExtra);

  const choose = async (choice: PermissionChoice) => {
    if (busy) return;
    setBusy(choice.option.optionId);
    setError(null);
    if (choice.role === "allow" || choice.role === "always") haptics.success();
    else haptics.light();
    try {
      await onChoose(choice.option.optionId);
    } catch (reason) {
      haptics.error();
      setError(describeActionError(reason));
      setBusy(null);
    }
  };

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: 8 }}>
      <View style={{ flexDirection: stacked ? "column" : "row", gap: 8, alignItems: stacked ? "stretch" : "center" }}>
        {compact && !stacked ? <View style={{ flex: 1 }} /> : null}
        {main.map((choice) => (
          <Button
            key={choice.option.optionId}
            title={choice.label}
            variant={choice.role === "allow" ? "primary" : "tonal"}
            size={size}
            style={{ minHeight: 44, justifyContent: "center" }}
            wide={!stacked && !compact}
            busy={busy === choice.option.optionId}
            disabled={disabled || (busy !== null && busy !== choice.option.optionId)}
            onPress={() => void choose(choice)}
          />
        ))}
        {compact && !stacked ? extra.map((choice) => (
          <Button key={choice.option.optionId} title={choice.label} variant="plain" size="small"
            busy={busy === choice.option.optionId}
            disabled={disabled || (busy !== null && busy !== choice.option.optionId)}
            onPress={() => void choose(choice)} />
        )) : null}
      </View>
      {extra.length && (!compact || stacked) ? (
        <View style={{ gap: 4, alignItems: "stretch" }}>
          {extra.map((choice) => (
            <Button
              key={choice.option.optionId}
              title={choice.label}
              variant="plain"
              size="small"
              style={{ minHeight: 44, justifyContent: "center" }}
              busy={busy === choice.option.optionId}
              disabled={disabled || (busy !== null && busy !== choice.option.optionId)}
              onPress={() => void choose(choice)}
            />
          ))}
        </View>
      ) : null}
      {error ? (
        <Text selectable style={[type.footnote, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
