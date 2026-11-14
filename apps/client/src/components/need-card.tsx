import type { SessionSummary } from "@linkshell/wire";
import { memo } from "react";
import { View } from "react-native";
import { PressableFeedback } from "./pressable-feedback";
import { Text } from "@/components/fixed-text";
import { useActions, useClient } from "@/lib/client";
import { sessionTitle, needsUserInput } from "@/lib/describe";
import { useLocale } from "@/lib/locale";
import { baseName, relativeTime } from "@/lib/format";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";
import { Icon } from "./icon";
import { Button } from "./button";
import { PermissionActions } from "./permission-actions";
import { openSession, SessionAvatar } from "./session-row";

/** A session waiting on the user, with its approval right on the card. */
export const NeedCard = memo(function NeedCard({ session, now, onPress }: { session: SessionSummary; now: number; onPress?: () => void }) {
  const { respond } = useActions();
  const { pick } = useLocale();
  const online = useClient((state) => state.status === "online");
  const permission = session.permission;
  const question = session.asyncQuestions?.[0];
  const asks = permission ? !!permission.questions?.length : needsUserInput(session);
  // An authorization link is only opened from the session, where its address is shown first:
  // accepting here would tell the agent "opened" without any page having been opened.
  const inSession = asks || !!permission?.url;
  const extra = Math.max(0, session.pendingPermissions + (session.asyncQuestions?.length ?? 0) - 1);

  const prompt = permission?.questions?.[0]?.text ?? question?.title ?? permission?.title ?? pick({ zh: "等你确认", en: "Waiting for your approval", ja: "承認待ち" });

  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderRadius: radius.card,
        borderCurve: "continuous",
        padding: 16,
        gap: 12,
      }}
    >
      <PressableFeedback
        feedback="button"
        onPress={onPress ?? (() => openSession(session.id))}
        accessibilityRole="button"
        accessibilityLabel={pick({ zh: `打开 ${sessionTitle(session)}`, en: `Open ${sessionTitle(session)}`, ja: `${sessionTitle(session)} を開く` })}
        style={{ flexDirection: "row", gap: 12, alignItems: "center" }}
      >
        <SessionAvatar session={session} size={32} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text numberOfLines={1} style={[type.headline, { flex: 1, color: colors.label }]}>
              {sessionTitle(session)}
            </Text>
            <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>{relativeTime(session.updatedAt, now)}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>
              {baseName(session.cwd)} · {agentLook(session.agent).short}
            </Text>
          </View>
        </View>
        <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} weight="semibold" />
      </PressableFeedback>

      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon
            sf={asks ? "questionmark.bubble.fill" : "hand.raised.fill"}
            md={asks ? "help" : "front_hand"}
            size={14}
            color={colors.waiting}
          />
          <Text numberOfLines={3} style={[type.subhead, { flex: 1, color: colors.label }]}>
            {prompt}
          </Text>
          {extra ? (
            <Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "500" }]}>{pick({ zh: `还有 ${extra} 项`, en: `${extra} more`, ja: `他 ${extra} 件` })}</Text>
          ) : null}
        </View>
        {permission?.detail && permission.detail !== prompt ? (
          <View style={{ backgroundColor: colors.code, borderRadius: radius.control, borderCurve: "continuous", paddingHorizontal: 10, paddingVertical: 8 }}>
            <Text selectable numberOfLines={4} style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.codeText }}>
              {permission.detail}
            </Text>
          </View>
        ) : null}
      </View>

      {inSession ? (
        // Questions are answered in the session, where there is room for them.
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={[type.footnote, { color: colors.waiting }]}>{asks ? pick({ zh: "等你回答", en: "Waiting for your answer", ja: "回答待ち" }) : pick({ zh: "等你确认", en: "Waiting for your approval", ja: "承認待ち" })}</Text>
          <Button title={asks ? pick({ zh: "回答", en: "Answer", ja: "回答" }) : pick({ zh: "查看", en: "Review", ja: "確認" })} variant="tonal" icon={{ sf: "arrow.right", md: "arrow_forward" }} onPress={onPress ?? (() => openSession(session.id))} />
        </View>
      ) : permission ? (
        <PermissionActions
          key={permission.requestId}
          options={permission.options}
          disabled={!online}
          compact
          maxExtra={1}
          onChoose={(optionId) => respond(session.id, permission.requestId, optionId)}
        />
      ) : null}
    </View>
  );
});
