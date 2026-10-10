import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View, type TextInputProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text, TextInput } from "./fixed-text";
import { Icon, type IconProps } from "./icon";
import { PressableScale } from "./pressable-scale";
import { SheetHeader, type SheetHeaderAction } from "./sheet-header";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";

type Symbol = Pick<IconProps, "sf" | "md">;

export function AcpSheet({ title, children, actions, onClose, focusMessage }: { title: string; children: ReactNode; actions?: SheetHeaderAction[]; onClose?(): void; focusMessage?: string }) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  useEffect(() => { if (focusMessage) scroll.current?.scrollTo({ y: 0, animated: true }); }, [focusMessage]);
  return <ScrollView ref={scroll} style={{ flex: 1, backgroundColor: colors.sheet }} automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingTop: Platform.OS === "android" ? 24 : 16, paddingBottom: Math.max(insets.bottom, 16) + 24 }}>
    <SheetHeader title={title} actions={actions} onClose={onClose} />
    <View style={{ width: "100%", maxWidth: 600, alignSelf: "center", gap: 24 }}>{children}</View>
  </ScrollView>;
}

export function AcpSection({ title, detail, children, padded = true }: { title?: string; detail?: string; children: ReactNode; padded?: boolean }) {
  return <View style={{ gap: 8 }}>
    {title ? <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 12 }]}>{title}</Text> : null}
    <View style={{ backgroundColor: colors.sheetCard, borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden", ...(padded ? { padding: 16, gap: 16 } : {}) }}>{children}</View>
    {detail ? <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 12 }]}>{detail}</Text> : null}
  </View>;
}

export function AcpDivider() { return <View style={{ height: StyleSheet.hairlineWidth, marginLeft: 56, backgroundColor: colors.separator }} />; }

export function AcpRow({ title, detail, icon, trailing, onPress, disabled, busy, destructive }: { title: string; detail?: string; icon: Symbol; trailing?: ReactNode; onPress?(): void; disabled?: boolean; busy?: boolean; destructive?: boolean }) {
  const tint = destructive ? colors.danger : colors.accent;
  const content = <View style={{ minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12, opacity: disabled ? 0.45 : 1 }}>
    <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}><Icon {...icon} size={21} color={tint} /></View>
    <View style={{ flex: 1, gap: 3 }}><Text style={[type.subhead, { fontWeight: "500", color: destructive ? colors.danger : colors.label }]}>{title}</Text>{detail ? <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>{detail}</Text> : null}</View>
    {busy ? <ActivityIndicator size="small" color={colors.accent} /> : trailing ?? (onPress ? <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} weight="semibold" /> : null)}
  </View>;
  return onPress ? <PressableScale onPress={onPress} disabled={disabled || busy} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}>{content}</PressableScale> : content;
}

export function AcpField({ label, value, onChange, helper, code, ...props }: Omit<TextInputProps, "value" | "onChangeText" | "onChange"> & { label: string; value: string; onChange(value: string): void; helper?: string; code?: boolean }) {
  const [focused, setFocused] = useState(false);
  return <View style={{ gap: 7 }}>
    <Text style={[type.footnote, { fontWeight: "500", color: colors.secondaryLabel }]}>{label}</Text>
    <TextInput {...props} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.placeholder as string} selectionColor={colors.accent} accessibilityLabel={label} onFocus={(event) => { setFocused(true); props.onFocus?.(event); }} onBlur={(event) => { setFocused(false); props.onBlur?.(event); }} style={[type.subhead, { color: colors.label, backgroundColor: colors.fill, borderRadius: radius.control, borderCurve: "continuous", paddingHorizontal: 12, paddingVertical: 12, minHeight: 48, maxHeight: props.multiline ? 200 : undefined, ...(props.multiline ? { minHeight: 88, textAlignVertical: "top" } : {}), ...(code ? { fontFamily: mono, fontSize: 13 } : {}), borderWidth: 1, borderColor: focused ? colors.accent : "transparent", opacity: props.editable === false ? 0.55 : 1 }, props.style]} />
    {helper ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{helper}</Text> : null}
  </View>;
}

export function AcpDisclosure({ title, detail, children, initiallyOpen = false }: { title: string; detail?: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <View style={{ gap: open ? 16 : 0 }}>
    <PressableScale onPress={() => setOpen((value) => !value)} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }}>
      <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10 }}><View style={{ flex: 1, gap: 3 }}><Text style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>{title}</Text>{detail ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{detail}</Text> : null}</View><Icon sf={open ? "chevron.up" : "chevron.down"} md={open ? "expand_less" : "expand_more"} size={16} color={colors.tertiaryLabel} /></View>
    </PressableScale>
    {open ? children : null}
  </View>;
}

export function AcpBanner({ message, kind = "error" }: { message: string; kind?: "error" | "success" | "info" }) {
  const foreground = kind === "error" ? colors.danger : kind === "success" ? colors.ok : colors.secondaryLabel;
  return <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 14, borderRadius: radius.row, borderCurve: "continuous", backgroundColor: kind === "error" ? colors.dangerSoft : kind === "success" ? colors.okSoft : colors.fill }}>
    <Icon sf={kind === "error" ? "exclamationmark.circle" : kind === "success" ? "checkmark.circle" : "info.circle"} md={kind === "error" ? "error_outline" : kind === "success" ? "check_circle" : "info"} size={18} color={foreground} />
    <Text selectable style={[type.footnote, { flex: 1, color: foreground }]}>{message}</Text>
  </View>;
}

export function AcpChoice<T extends string>({ label, value, choices, onChange, disabled }: { label: string; value: T; choices: { value: NoInfer<T>; label: string }[]; onChange(value: T): void; disabled?: boolean }) {
  return <View style={{ gap: 8 }}><Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "500" }]}>{label}</Text><View style={{ flexDirection: "row", gap: 4, padding: 4, backgroundColor: colors.fill, borderRadius: radius.control, borderCurve: "continuous" }}>
    {choices.map((choice) => <PressableScale key={choice.value} onPress={() => onChange(choice.value)} disabled={disabled} accessibilityRole="radio" accessibilityLabel={choice.label} accessibilityState={{ selected: choice.value === value, checked: choice.value === value, disabled: !!disabled }} outerStyle={{ flex: 1 }}>
      <View style={{ minHeight: 40, paddingHorizontal: 6, paddingVertical: 8, alignItems: "center", justifyContent: "center", borderRadius: radius.chip, backgroundColor: choice.value === value ? colors.sheetCard : "transparent", opacity: disabled ? 0.5 : 1 }}><Text style={[type.footnote, { fontWeight: choice.value === value ? "600" : "500", color: choice.value === value ? colors.label : colors.secondaryLabel, textAlign: "center" }]}>{choice.label}</Text></View>
    </PressableScale>)}
  </View></View>;
}

export function AcpLoading() {
  return <View accessibilityLabel="正在读取 Agent 配置" accessibilityState={{ busy: true }} style={{ gap: 24 }}>
    <AcpSection><View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}><View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.fill }} /><View style={{ flex: 1, gap: 8 }}><View style={{ width: "42%", height: 14, borderRadius: 4, backgroundColor: colors.fill }} /><View style={{ width: "65%", height: 10, borderRadius: 4, backgroundColor: colors.fill }} /></View><ActivityIndicator size="small" color={colors.secondaryLabel} /></View></AcpSection>
    {[0, 1].map((key) => <AcpSection key={key}><View style={{ width: "32%", height: 12, borderRadius: 4, backgroundColor: colors.fill }} /><View style={{ height: 44, borderRadius: radius.control, backgroundColor: colors.fill }} /></AcpSection>)}
  </View>;
}
