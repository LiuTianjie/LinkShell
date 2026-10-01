import type { MenuAction } from "@react-native-menu/menu";
import { AppMenu } from "@/components/app-menu";
import type { SessionConfigOption } from "@linkshell/wire";
import { Text, View } from "react-native";
import { haptics } from "@/lib/haptics";
import { chipLabel, isRisky, isToggle, modelChipLabel, optionLabel, valueHint, valueLabel } from "@/lib/labels";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "./icon";

/** A compact chip that opens the platform's native menu for one session setting. */
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
  const tint = risky ? colors.waiting : colors.label;
  // One line per choice: its name, and a check on the current one. Descriptions made a menu of six fill half the screen.
  const actions: MenuAction[] = option.values.map((value) => ({
    id: value.value,
    title: valueLabel(option, value.value),
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
      {option.category === "mode" ? (
        // Permissions are a glance, not a label: a shield, orange when the agent can do anything.
        <View
          accessibilityRole="button"
          accessibilityLabel={`${optionLabel(option)}：${valueLabel(option, option.current)}`}
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: risky ? colors.waitingSoft : undefined,
            alignItems: "center",
            justifyContent: "center",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Icon
            sf={risky ? "exclamationmark.shield.fill" : "lock.shield"}
            md={risky ? "gpp_maybe" : "shield"}
            size={15}
            color={risky ? colors.waiting : colors.secondaryLabel}
          />
        </View>
      ) : (
        <View
          accessibilityRole="button"
          accessibilityLabel={`${optionLabel(option)}：${valueLabel(option, option.current)}`}
          style={{ height: 30, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 3, opacity: disabled ? 0.5 : 1 }}
        >
          <Text numberOfLines={1} style={[type.footnote, { color: tint, fontWeight: option.category === "model" ? "600" : "500", maxWidth: 150 }]}>
            {option.category === "model" ? modelChipLabel(option) : chipLabel(option)}
          </Text>
          <Icon sf="chevron.down" md="expand_more" size={8} color={colors.tertiaryLabel} weight="bold" />
        </View>
      )}
    </AppMenu>
  );
}

/**
 * Every session setting as its own chip: model, reasoning effort, permissions,
 * fast mode. Effort used to hide inside the model's menu, where nobody found it.
 */
export function ConfigMenus({
  options,
  onChange,
  disabled,
}: {
  options: SessionConfigOption[];
  onChange: (optionId: string, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {options.map((option) =>
        isToggle(option) ? (
          <ToggleChip key={option.id} option={option} disabled={disabled} onChange={(value) => onChange(option.id, value)} />
        ) : (
          <ConfigMenu key={option.id} option={option} disabled={disabled} onChange={(value) => onChange(option.id, value)} />
        ),
      )}
    </>
  );
}

/**
 * An on/off setting (the agent's fast mode): a chip like its neighbours, lit
 * when on, that opens a two-line menu saying what it does. Off looks like any
 * other chip, not like something that can't be used.
 */
function ToggleChip({ option, onChange, disabled }: { option: SessionConfigOption; onChange: (value: string) => void; disabled?: boolean }) {
  const on = option.current === "on";
  const label = optionLabel(option).replace(/模式$/, "");
  const hint = option.id === "fast" ? "输出更快，可能消耗更多额度" : valueHint(option, "on");
  const glyph = option.id === "plan" ? ({ sf: "list.bullet.clipboard", md: "checklist" } as const) : ({ sf: on ? "bolt.fill" : "bolt", md: "bolt" } as const);
  const actions: MenuAction[] = (["off", "on"] as const).map((value) => ({
    id: value,
    title: valueLabel(option, value),
    state: value === option.current ? "on" : "off",
    attributes: { disabled },
  }));
  return (
    <AppMenu
      title={hint ? `${optionLabel(option)} · ${hint}` : optionLabel(option)}
      actions={actions}
      shouldOpenOnLongPress={false}
      onOpenMenu={() => haptics.selection()}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event !== option.current) onChange(nativeEvent.event);
      }}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel={`${optionLabel(option)}：${valueLabel(option, option.current)}`}
        accessibilityHint={hint}
        style={{
          height: 30,
          paddingHorizontal: on ? 8 : 6,
          borderRadius: 15,
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          backgroundColor: on ? colors.accentSoft : undefined,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Icon sf={glyph.sf} md={glyph.md} size={12} color={on ? colors.accent : colors.secondaryLabel} />
        <Text style={[type.footnote, { color: on ? colors.accent : colors.label, fontWeight: on ? "600" : "500" }]}>{label}</Text>
        {on ? null : <Icon sf="chevron.down" md="expand_more" size={8} color={colors.tertiaryLabel} weight="bold" />}
      </View>
    </AppMenu>
  );
}
