import {
  DESKTOP_SHORTCUT_META,
  DESKTOP_SHORTCUTS,
  SHORTCUT_SHEET_EXTRAS,
  formatShortcut,
  type DesktopShortcutId,
  type ShortcutSectionId,
} from "../../bridge/shortcuts";
import { useActiveDesktopPlatform, useI18n, useRouter, type DesktopI18nKey } from "../../core";
import {
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
  Kbd,
} from "../../primitives";

const SECTION_ORDER: readonly { id: ShortcutSectionId; title: DesktopI18nKey }[] = [
  { id: "navigation", title: "desktop.shell.sectionNavigation" },
  { id: "panes", title: "desktop.shell.sectionPanes" },
  { id: "session", title: "desktop.shell.sectionSession" },
  { id: "screen", title: "desktop.shell.sectionScreen" },
];

export interface ShortcutSheetRow {
  label: DesktopI18nKey;
  keys: string;
}

/**
 * Built from the binding table plus the features' own bound keys, so the sheet cannot advertise a
 * shortcut nothing handles (it used to list Esc-to-stop and ⌘⇧F, neither of which existed).
 */
export function shortcutSheetSections(
  platform: "macos" | "windows" | "linux",
): { id: ShortcutSectionId; title: DesktopI18nKey; rows: ShortcutSheetRow[] }[] {
  return SECTION_ORDER.map((section) => {
    const rows: ShortcutSheetRow[] = [];
    for (const id of Object.keys(DESKTOP_SHORTCUTS) as DesktopShortcutId[]) {
      const meta = DESKTOP_SHORTCUT_META[id];
      if (meta.section !== section.id) continue;
      rows.push({ label: meta.label, keys: formatShortcut(DESKTOP_SHORTCUTS[id], platform) });
    }
    for (const extra of SHORTCUT_SHEET_EXTRAS) {
      if (extra.section !== section.id) continue;
      if (extra.platforms && !extra.platforms.includes(platform)) continue;
      const keys = extra.binding
        ? formatShortcut(extra.binding, platform)
        : formatShortcut({ key: "#" }, platform).replace("#", extra.text ?? "");
      rows.push({ label: extra.label, keys });
    }
    return { ...section, rows };
  }).filter((section) => section.rows.length > 0);
}

export function ShortcutsHelpDialog() {
  const { t } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const open = useRouter((s) => s.shortcutSheetOpen);
  const setOpen = useRouter((s) => s.setShortcutSheetOpen);

  const sections = shortcutSheetSections(activePlatform);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="md"
      dismissible
      aria-label={t("desktop.shortcuts")}
    >
      <DialogHeader>
        <DialogTitle>{t("desktop.shortcuts")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="shortcuts-grid">
          {sections.map((section) => (
            <div key={section.id} className="shortcuts-section">
              <div className="shortcuts-section__title">{t(section.title)}</div>
              {section.rows.map((row) => (
                <div key={`${row.label}:${row.keys}`} className="shortcuts-row">
                  <span>{t(row.label)}</span>
                  <Kbd>{row.keys}</Kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
}
