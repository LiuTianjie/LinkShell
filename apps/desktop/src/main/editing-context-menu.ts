import { Menu, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from "electron";

export interface EditingLabels { undo: string; redo: string; cut: string; copy: string; paste: string; delete: string; selectAll: string }

const ZH_LABELS: EditingLabels = { undo: "撤销", redo: "重做", cut: "剪切", copy: "复制", paste: "粘贴", delete: "删除", selectAll: "全选" };

export function installEditingContextMenu(web: WebContents, getWindow: () => BrowserWindow | undefined, trusted: () => boolean, labels: () => EditingLabels = () => ZH_LABELS): void {
  web.on("context-menu", (_event, params) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || !trusted() || !params.frame) return;
    // Electron has no default editing menu. Chromium's edit flags preserve read-only and
    // password-field restrictions; native roles act on the clicked frame without a page bridge.
    // Rows with their own menus cancel the DOM contextmenu event before it reaches Electron.
    if (!params.isEditable && !params.selectionText) return;
    const flags = params.editFlags;
    const text = labels();
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) items.push(
      { label: text.undo, role: "undo", enabled: flags.canUndo },
      { label: text.redo, role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { label: text.cut, role: "cut", enabled: flags.canCut },
    );
    items.push({ label: text.copy, role: "copy", enabled: flags.canCopy });
    if (params.isEditable) items.push(
      { label: text.paste, role: "paste", enabled: flags.canPaste },
      { label: text.delete, role: "delete", enabled: flags.canDelete },
    );
    items.push({ type: "separator" }, { label: text.selectAll, role: "selectAll", enabled: flags.canSelectAll });
    Menu.buildFromTemplate(items).popup({ window, frame: params.frame });
  });
}
