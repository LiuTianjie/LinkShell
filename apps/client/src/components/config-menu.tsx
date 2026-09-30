import type { MenuAction } from "@react-native-menu/menu";
import { AppMenu } from "@/components/app-menu";
import type { SessionConfigOption } from "@linkshell/wire";
import { Pressable, Text, View } from "react-native";
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
  const actions: MenuAction[] = option.values.map((value) => ({
    id: value.value,
    title: valueLabel(option, value.value),
    subtitle: valueHint(option, value.value),
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
          <Text numberOfLines={1} style={[type.footnote, { color: tint, fontWeight: "500", maxWidth: 140 }]}>
            {chipLabel(option)}
          </Text>
          <Icon sf="chevron.down" md="expand_more" size={8} color={colors.tertiaryLabel} weight="bold" />
        </View>
      )}
    </AppMenu>
  );
}

/**
 * Model and reasoning effort as one chip ("GPT-5 · 高"), effort in a submenu:
 * they're chosen together, and one chip leaves room for the rest on a phone.
 */
export function ModelMenu({
  model,
  effort,
  onChange,
  disabled = false,
}: {
  model: SessionConfigOption;
  effort: SessionConfigOption;
  onChange: (optionId: string, value: string) => void;
  disabled?: boolean;
}) {
  const actions: MenuAction[] = [
    ...model.values.map((value) => ({
      id: `m:${value.value}`,
      title: valueLabel(model, value.value),
      subtitle: valueHint(model, value.value),
      state: value.value === model.current ? ("on" as const) : ("off" as const),
      attributes: { disabled },
    })),
    {
      id: "effort",
      title: `${optionLabel(effort)} · ${valueLabel(effort, effort.current)}`,
      image: "brain",
      subactions: effort.values.map((value) => ({
        id: `e:${value.value}`,
        title: valueLabel(effort, value.value),
        subtitle: valueHint(effort, value.value),
        state: value.value === effort.current ? ("on" as const) : ("off" as const),
        attributes: { disabled },
      })),
    },
  ];
  return (
    <AppMenu
      title="模型 · 从下一条消息开始生效"
      actions={actions}
      shouldOpenOnLongPress={false}
      onOpenMenu={() => haptics.selection()}
      onPressAction={({ nativeEvent }) => {
        const [kind, value] = [nativeEvent.event.slice(0, 2), nativeEvent.event.slice(2)];
        if (kind === "m:" && value !== model.current) onChange(model.id, value);
        if (kind === "e:" && value !== effort.current) onChange(effort.id, value);
      }}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel={`模型：${valueLabel(model, model.current)}，${optionLabel(effort)}：${valueLabel(effort, effort.current)}`}
        style={{ height: 30, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 3, opacity: disabled ? 0.5 : 1 }}
      >
        <Text numberOfLines={1} style={[type.footnote, { color: colors.label, fontWeight: "600", maxWidth: 170 }]}>
          {modelChipLabel(model)}
          {effort.current !== "default" ? (
            <Text style={{ color: colors.secondaryLabel, fontWeight: "500" }}> · {valueLabel(effort, effort.current)}</Text>
          ) : null}
        </Text>
        <Icon sf="chevron.down" md="expand_more" size={8} color={colors.tertiaryLabel} weight="bold" />
      </View>
    </AppMenu>
  );
}

/** Every session setting as chips, model and effort merged when an agent has both. */
export function ConfigMenus({
  options,
  onChange,
  disabled,
}: {
  options: SessionConfigOption[];
  onChange: (optionId: string, value: string) => void;
  disabled?: boolean;
}) {
  const model = options.find((option) => option.category === "model");
  const effort = options.find((option) => option.category === "effort");
  const merged = model && effort && model.values.length > 0 && effort.values.length > 0;
  return (
    <>
      {merged ? <ModelMenu model={model} effort={effort} onChange={onChange} disabled={disabled} /> : null}
      {options
        .filter((option) => !merged || (option !== model && option !== effort))
        .map((option) =>
          isToggle(option) ? (
            <ToggleChip key={option.id} option={option} disabled={disabled} onChange={(value) => onChange(option.id, value)} />
          ) : (
            <ConfigMenu key={option.id} option={option} disabled={disabled} onChange={(value) => onChange(option.id, value)} />
          ),
        )}
    </>
  );
}

/** An on/off setting as one tap: lit when on. */
function ToggleChip({ option, onChange, disabled }: { option: SessionConfigOption; onChange: (value: string) => void; disabled?: boolean }) {
  const on = option.current === "on";
  const label = optionLabel(option).replace(/模式$/, "");
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        haptics.selection();
        onChange(on ? "off" : "on");
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={optionLabel(option)}
      accessibilityHint={valueHint(option, "on")}
      style={{
        height: 30,
        paddingHorizontal: 8,
        borderRadius: 15,
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        backgroundColor: on ? colors.accentSoft : undefined,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon sf={on ? "bolt.fill" : "bolt"} md="bolt" size={12} color={on ? colors.accent : colors.tertiaryLabel} />
      <Text style={[type.footnote, { color: on ? colors.accent : colors.secondaryLabel, fontWeight: on ? "600" : "400" }]}>{label}</Text>
    </Pressable>
  );
}
