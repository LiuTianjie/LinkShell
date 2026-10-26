import type { MenuAction } from "@react-native-menu/menu";
import { AppMenu } from "@/components/app-menu";
import type { SessionConfigOption } from "@linkshell/wire";
import { Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { haptics } from "@/lib/haptics";
import { isRisky, isToggle, modelChipLabel, optionLabel, valueLabel } from "@/lib/labels";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "./icon";

/** The value of one session setting, at the end of its row; a tap opens the platform's menu of choices. */
export function ConfigMenu({
  option,
  onChange,
  disabled = false,
}: {
  option: SessionConfigOption;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const risky = option.category === "mode" && isRisky(option.current);
  // One line per choice: its name, and a check on the current one. Descriptions made a menu of six fill half the screen.
  const actions: MenuAction[] = option.values.map((value) => ({
    id: value.value,
    title: value.group ? `${value.group} · ${valueLabel(option, value.value)}` : valueLabel(option, value.value),
    subtitle: value.description,
    state: value.value === option.current ? "on" : "off",
    attributes: { disabled },
  }));
  return (
    <AppMenu
      title={`${optionLabel(option)} · 从下一条消息开始生效`}
      actions={actions}
      shouldOpenOnLongPress={false}
      onOpenMenu={() => haptics.selection()}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event !== option.current) onChange(nativeEvent.event);
      }}
    >
      {/* One shape for every setting: the value on the right, a shield before a permission mode (orange when the agent can do anything). */}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${optionLabel(option)}：${valueLabel(option, option.current)}`}
        style={{ minHeight: 44, paddingVertical: 7, paddingLeft: 6, flexDirection: "row", alignItems: "center", gap: 5, opacity: disabled ? 0.5 : 1 }}
      >
        {option.category === "mode" ? (
          <Icon sf={risky ? "exclamationmark.shield.fill" : "lock.shield"} md={risky ? "gpp_maybe" : "shield"} size={14} color={risky ? colors.waiting : colors.secondaryLabel} />
        ) : null}
        <Text numberOfLines={1} style={[type.subhead, { color: risky ? colors.waiting : colors.secondaryLabel, maxWidth: 170 }]}>
          {option.category === "model" ? modelChipLabel(option) : valueLabel(option, option.current)}
        </Text>
        <Icon sf="chevron.up.chevron.down" md="unfold_more" size={11} color={colors.tertiaryLabel} weight="semibold" />
      </View>
    </AppMenu>
  );
}

/**
 * All of a session's settings as one chip beside the input: the model and its
 * effort, a shield when the agent can do anything, and what's switched on.
 * One tap opens the settings sheet with every option, rather than a row of
 * chips that has to be scrolled sideways.
 */
export function ConfigSummary({ options, onPress, disabled = false }: { options: SessionConfigOption[]; onPress: () => void; disabled?: boolean }) {
  const model = options.find((option) => option.category === "model");
  const effort = options.find((option) => option.category === "effort");
  const mode = options.find((option) => option.category === "mode" && !isToggle(option));
  const risky = !!mode && isRisky(mode.current);
  const on = options.filter((option) => isToggle(option) && option.current === "on");
  const words = [model ? modelChipLabel(model) : mode ? valueLabel(mode, mode.current) : undefined, effort ? valueLabel(effort, effort.current) : undefined].filter(Boolean).join(" · ");
  const label = options.map((option) => `${optionLabel(option)}：${valueLabel(option, option.current)}`).join("，");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`会话设置，${label}`}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      disabled={disabled}
      style={{ minHeight: 44, minWidth: 0, flexShrink: 1, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 5, opacity: disabled ? 0.5 : 1 }}
    >
      {risky ? <Icon sf="exclamationmark.shield.fill" md="gpp_maybe" size={14} color={colors.waiting} /> : null}
      {on.map((option) => (
        <Icon key={option.id} sf={option.id === "plan" ? "list.bullet.clipboard" : "bolt.fill"} md={option.id === "plan" ? "checklist" : "bolt"} size={13} color={colors.accent} />
      ))}
      <Text numberOfLines={1} style={[type.footnote, { flexShrink: 1, color: colors.label, fontWeight: "600" }]}>{words || "会话设置"}</Text>
      <Icon sf="chevron.down" md="expand_more" size={8} color={colors.tertiaryLabel} weight="bold" />
    </Pressable>
  );
}
