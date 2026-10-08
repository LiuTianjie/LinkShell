import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel, FieldGroup } from "./ui/field";

type Request = {
  kind: "confirm" | "prompt" | "alert" | "choice";
  choices?: { value: string; label: string; destructive?: boolean }[];
  text: string;
  initial?: string;
};
type Ask = (request: Request) => Promise<string | null>;
const DialogContext = createContext<Ask | null>(null);
export function useDialogs() {
  const ask = useContext(DialogContext);
  if (!ask) throw new Error("缺少弹窗容器");
  return {
    choose: (text: string, choices: NonNullable<Request["choices"]>) =>
      ask({ kind: "choice", text, choices }),
    confirm: (text: string) =>
      ask({ kind: "confirm", text }).then((value) => value !== null),
    prompt: (text: string, initial = "") =>
      ask({ kind: "prompt", text, initial }),
    alert: (text: string) => ask({ kind: "alert", text }),
  };
}
export function Dialogs({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState("");
  const pending = useRef<((value: string | null) => void) | null>(null);
  const ask = useCallback<Ask>((request) => {
    if (pending.current) return Promise.resolve(null);
    setValue(request.initial ?? "");
    setRequest(request);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }, []);
  function finish(value: string | null) {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(value);
  }
  useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    [],
  );
  return (
    <DialogContext.Provider value={ask}>
      {children}
      {request?.kind === "confirm" || request?.kind === "choice" ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) finish(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认操作</AlertDialogTitle>
              <AlertDialogDescription>{request.text}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => finish(null)}>
                取消
              </AlertDialogCancel>
              {(
                request.choices ?? [
                  { value: "confirmed", label: "确认", destructive: true },
                ]
              ).map((choice) => (
                <AlertDialogAction
                  key={choice.value}
                  variant={choice.destructive ? "destructive" : "default"}
                  onClick={() => finish(choice.value)}
                >
                  {choice.label}
                </AlertDialogAction>
              ))}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        request && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) finish(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {request.kind === "prompt" ? request.text : "上下文用量"}
                </DialogTitle>
                <DialogDescription
                  className={request.kind === "prompt" ? "sr-only" : undefined}
                >
                  {request.kind === "prompt"
                    ? "填写后保存，取消不会修改。"
                    : request.text}
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  finish(value.trim());
                }}
              >
                <FieldGroup>
                  {request.kind === "prompt" && (
                    <Field>
                      <FieldLabel htmlFor="dialog-value">
                        {request.text}
                      </FieldLabel>
                      <Input
                        id="dialog-value"
                        autoFocus
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        required
                      />
                    </Field>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => finish(null)}
                    >
                      取消
                    </Button>
                    <Button
                      type="submit"
                      disabled={request.kind === "prompt" && !value.trim()}
                    >
                      {request.kind === "prompt" ? "保存" : "知道了"}
                    </Button>
                  </div>
                </FieldGroup>
              </form>
            </DialogContent>
          </Dialog>
        )
      )}
    </DialogContext.Provider>
  );
}
