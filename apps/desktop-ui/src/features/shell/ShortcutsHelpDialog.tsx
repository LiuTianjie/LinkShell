import { useActiveDesktopPlatform, useI18n, useRouter } from "../../core";
import {
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
  Kbd,
} from "../../primitives";

export function ShortcutsHelpDialog() {
  const { locale, t } = useI18n();
  const activePlatform = useActiveDesktopPlatform();
  const open = useRouter((s) => s.shortcutSheetOpen);
  const setOpen = useRouter((s) => s.setShortcutSheetOpen);

  const inspectorShortcut = activePlatform === "macos" ? "Opt+Mod+B" : "Ctrl+Alt+B";

  const sections = [
    {
      title:
        locale === "en"
          ? "Navigation & Global"
          : locale === "ja"
            ? "ナビゲーション"
            : "全局与导航",
      rows: [
        { label: t("desktop.commandCenter"), shortcut: "Mod+K" },
        { label: t("desktop.newSession"), shortcut: "Mod+N" },
        { label: t("desktop.manage.settings"), shortcut: "Mod+," },
        {
          label: locale === "en" ? "Back / Forward" : locale === "ja" ? "戻る / 進む" : "后退 / 前进",
          shortcut: "Mod+[",
        },
        { label: t("desktop.shortcuts"), shortcut: "?" },
      ],
    },
    {
      title:
        locale === "en"
          ? "Workbench Panes"
          : locale === "ja"
            ? "ワークベンチ"
            : "工作台分栏与终端",
      rows: [
        { label: t("desktop.toggleSidebar"), shortcut: "Mod+B" },
        { label: t("desktop.toggleBottomDock"), shortcut: "Mod+J" },
        { label: t("desktop.toggleInspector"), shortcut: inspectorShortcut },
      ],
    },
    {
      title:
        locale === "en"
          ? "Session & Composer"
          : locale === "ja"
            ? "セッションと入力"
            : "会话与消息发送",
      rows: [
        { label: t("desktop.composer.send"), shortcut: "Enter" },
        {
          label: locale === "en" ? "New line" : locale === "ja" ? "改行" : "换行",
          shortcut: "Shift+Enter",
        },
        { label: t("desktop.timeline.searchPlaceholder"), shortcut: "Mod+F" },
        { label: t("desktop.composer.stop"), shortcut: "Esc" },
      ],
    },
    {
      title:
        locale === "en"
          ? "Remote Screen & Fusion Mode"
          : locale === "ja"
            ? "リモート画面と融合モード"
            : "远程屏幕与融合模式",
      rows:
        activePlatform === "macos"
          ? [
              { label: t("desktop.fusion.title"), shortcut: "Mod+Shift+F" },
              { label: t("desktop.screen.fullscreen"), shortcut: "Ctrl+Shift+F" },
            ]
          : [
              { label: t("desktop.screen.fullscreen"), shortcut: "F11" },
            ],
    },
  ];

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
            <div key={section.title} className="shortcuts-section">
              <div className="shortcuts-section__title">{section.title}</div>
              {section.rows.map((row) => (
                <div key={row.label} className="shortcuts-row">
                  <span>{row.label}</span>
                  <Kbd shortcut={row.shortcut} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
}
