import type { PermissionOption } from "@linkshell/wire";
import { useState } from "react";
import { Text, View } from "react-native";
import { permissionChoices, type PermissionChoice } from "@/lib/describe";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Button } from "./button";

/**
 * Reject / allow buttons for a permission request, plus the less common
 * choices as quieter buttons underneath. Resolves itself when the host
 * reports the answer (from here or from the computer).
 */
export function PermissionActions({
  options,
  onChoose,
  disabled = false,
  size = "medium",
  maxExtra = 2,
}: {
  options: PermissionOption[];
  onChoose: (optionId: string) => Promise<void>;
  disabled?: boolean;
  size?: "medium" | "large";
  maxExtra?: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = permissionChoices(options);
  const reject = choices.find((c) => c.role === "reject");
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
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(null);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {main.map((choice) => (
          <Button
            key={choice.option.optionId}
            title={choice.label}
            variant={choice.role === "allow" ? "primary" : "tonal"}
            size={size}
            wide
            busy={busy === choice.option.optionId}
            disabled={disabled || (busy !== null && busy !== choice.option.optionId)}
            onPress={() => void choose(choice)}
          />
        ))}
      </View>
      {extra.length ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {extra.map((choice) => (
            <Button
              key={choice.option.optionId}
              title={choice.label}
              variant={choice.role === "stop" ? "destructive" : "plain"}
              size="small"
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
