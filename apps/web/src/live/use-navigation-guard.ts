import { useRef } from "react";
import { useDialogs } from "@/components/Dialogs";
import { hasUnsavedWork } from "./unsaved-work";

export function useNavigationGuard() {
  const dialogs = useDialogs();
  const pending = useRef(false);
  return async (action: () => void) => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (
        hasUnsavedWork() &&
        !(await dialogs.confirm("文件还有未保存的修改。放弃修改并离开编辑器？"))
      )
        return;
      action();
    } finally {
      pending.current = false;
    }
  };
}
