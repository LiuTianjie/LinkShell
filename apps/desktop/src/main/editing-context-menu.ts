import { Menu, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from "electron";

export function installEditingContextMenu(web: WebContents, getWindow: () => BrowserWindow | undefined, trusted: () => boolean): void {
  web.on("context-menu", (_event, params) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || !trusted() || !params.frame) return;
    // Electron has no default editing menu. Chromium's edit flags preserve read-only and
    // password-field restrictions; native roles act on the clicked frame without a page bridge.
    // Rows with their own menus cancel the DOM contextmenu event before it reaches Electron.
    if (!params.isEditable && !params.selectionText) return;
    const flags = params.editFlags;
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) items.push(
      { label: "撤销", role: "undo", enabled: flags.canUndo },
      { label: "重做", role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { label: "剪切", role: "cut", enabled: flags.canCut },
    );
    items.push({ label: "复制", role: "copy", enabled: flags.canCopy });
    if (params.isEditable) items.push(
      { label: "粘贴", role: "paste", enabled: flags.canPaste },
      { label: "删除", role: "delete", enabled: flags.canDelete },
    );
    items.push({ type: "separator" }, { label: "全选", role: "selectAll", enabled: flags.canSelectAll });
    Menu.buildFromTemplate(items).popup({ window, frame: params.frame });
  });
}
