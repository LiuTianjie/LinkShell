import type { SessionSummary } from "@linkshell/wire";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useActions, useClient } from "@/lib/client";
import { sessionTitle, needsUserInput } from "@/lib/describe";
import { baseName, relativeTime } from "@/lib/format";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { Icon } from "./icon";
import { Button } from "./button";
import { PermissionActions } from "./permission-actions";
import { openSession, SessionAvatar, UserInputBadge } from "./session-row";

/** A session waiting on the user, with its approval right on the card. */
export const NeedCard = memo(function NeedCard({ session, now, onPress }: { session: SessionSummary; now: number; onPress?: () => void }) {
  const { respond } = useActions();
  const online = useClient((state) => state.status === "online");
  const permission = session.permission;
  const question = session.asyncQuestions?.[0];
  const asks = permission ? !!permission.questions?.length : needsUserInput(session);
  const extra = Math.max(0, session.pendingPermissions + (session.asyncQuestions?.length ?? 0) - 1);

  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderRadius: 24,
        borderCurve: "continuous",
        padding: 14,
        gap: 12,
        boxShadow: "0 0 0 1px rgba(232,131,12,0.28), 0 6px 20px rgba(232,131,12,0.08)",
      }}
    >
      <Pressable
        onPress={onPress ?? (() => openSession(session.id))}
        accessibilityRole="button"
        accessibilityLabel={`打开 ${sessionTitle(session)}`}
        style={{ flexDirection: "row", gap: 12, alignItems: "center" }}
      >
        <SessionAvatar session={session} size={38} />
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
            {needsUserInput(session) ? <UserInputBadge /> : null}
          </View>
        </View>
        <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} weight="semibold" />
      </Pressable>

      <View style={{ backgroundColor: colors.waitingSoft, borderRadius: 16, borderCurve: "continuous", padding: 12, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon
            sf={asks ? "questionmark.bubble.fill" : "hand.raised.fill"}
            md={asks ? "help" : "front_hand"}
            size={14}
            color={colors.waiting}
          />
          <Text numberOfLines={2} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
            {permission?.title ?? question?.title ?? "需要你的确认"}
          </Text>
          {extra ? (
            <Text style={[type.caption, { color: colors.waiting, fontWeight: "600" }]}>还有 {extra} 项</Text>
          ) : null}
        </View>
        {permission?.detail ? (
          <Text selectable numberOfLines={4} style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: colors.codeText }}>
            {permission.detail}
          </Text>
        ) : null}
      </View>

      {asks ? (
        // Questions are answered in the session, where there is room for them.
        <Button title="去回答" variant="primary" wide onPress={onPress ?? (() => openSession(session.id))} />
      ) : permission ? (
        <PermissionActions
          key={permission.requestId}
          options={permission.options}
          disabled={!online}
          maxExtra={1}
          onChoose={(optionId) => respond(session.id, permission.requestId, optionId)}
        />
      ) : null}
    </View>
  );
});
