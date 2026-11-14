import { useSyncExternalStore } from "react";

/**
 * The words the primitives fall back to when a caller passes none (a dialog's close button, a
 * confirm's two answers). They follow the app's language without the primitives depending on the
 * app's dictionaries: the app tells them which language is on.
 */
export interface PrimitiveLabels {
  close: string;
  cancel: string;
  confirm: string;
  save: string;
  gotIt: string;
  notice: string;
  confirmTitle: string;
  promptHint: string;
  copy: string;
  copied: string;
  select: string;
  filter: string;
  noMatches: string;
  noData: string;
  resizeHint: string;
  panelFailed: string;
  retry: string;
}

export type PrimitiveLocale = "zh" | "en" | "ja";

const LABELS: Record<PrimitiveLocale, PrimitiveLabels> = {
  zh: {
    close: "关闭",
    cancel: "取消",
    confirm: "确认",
    save: "保存",
    gotIt: "知道了",
    notice: "提示",
    confirmTitle: "确认操作",
    promptHint: "填写后确认，取消不会修改。",
    copy: "复制",
    copied: "已复制",
    select: "选择",
    filter: "筛选",
    noMatches: "无匹配结果",
    noData: "暂无数据",
    resizeHint: "拖动调整尺寸，双击恢复默认",
    panelFailed: "这部分界面出错了",
    retry: "重试",
  },
  en: {
    close: "Close",
    cancel: "Cancel",
    confirm: "Confirm",
    save: "Save",
    gotIt: "OK",
    notice: "Notice",
    confirmTitle: "Are you sure?",
    promptHint: "Confirm to apply; cancelling changes nothing.",
    copy: "Copy",
    copied: "Copied",
    select: "Select",
    filter: "Filter",
    noMatches: "No matches",
    noData: "Nothing here yet",
    resizeHint: "Drag to resize, double-click to reset",
    panelFailed: "This part of the window ran into a problem",
    retry: "Try again",
  },
  ja: {
    close: "閉じる",
    cancel: "キャンセル",
    confirm: "確認",
    save: "保存",
    gotIt: "OK",
    notice: "お知らせ",
    confirmTitle: "操作の確認",
    promptHint: "入力して確定します。キャンセルしても変更されません。",
    copy: "コピー",
    copied: "コピーしました",
    select: "選択",
    filter: "絞り込み",
    noMatches: "一致する項目がありません",
    noData: "データがありません",
    resizeHint: "ドラッグでサイズ変更、ダブルクリックで元に戻す",
    panelFailed: "この部分の表示で問題が発生しました",
    retry: "再試行",
  },
};

let current: PrimitiveLabels = LABELS.zh;
const listeners = new Set<() => void>();

export function setPrimitiveLocale(locale: string): void {
  const next = LABELS[locale as PrimitiveLocale] ?? LABELS.zh;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getPrimitiveLabels(): PrimitiveLabels {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrimitiveLabels(): PrimitiveLabels {
  return useSyncExternalStore(subscribe, getPrimitiveLabels, getPrimitiveLabels);
}
