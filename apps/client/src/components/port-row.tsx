import type { PortInfo } from "@linkshell/wire";
import { router } from "expo-router";
import { memo } from "react";
import { baseName } from "@/lib/format";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";
import { ListRow, type RowPosition } from "./session-row";

export function openPreview(port: number, title?: string) {
  router.push({ pathname: "/preview", params: { port: String(port), ...(title ? { title } : {}) } });
}

/** A server on the computer: its page title (or address), project and process. */
export const PortRow = memo(function PortRow({ entry, position }: { entry: PortInfo; position: RowPosition }) {
  const project = entry.cwd ? baseName(entry.cwd) : undefined;
  const address = `localhost:${entry.port}`;
  return (
    <ListRow
      leading={<Icon sf="globe" md="language" size={20} color={colors.accent} />}
      title={entry.title ?? address}
      time={entry.title ? `:${entry.port}` : ""}
      project={project}
      detail={entry.process}
      position={position}
      onPress={() => openPreview(entry.port, entry.title)}
      accessibilityLabel={[entry.title ?? address, project, entry.process].filter(Boolean).join("，")}
    />
  );
});
