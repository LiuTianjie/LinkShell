import { useId, useState } from "react";
import { useStore } from "zustand";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import type { Computer } from "./engine";
import {
  COMPUTER_NAME_LIMIT,
  computerIdentity,
  computerName,
  computerNames,
} from "./computer-names";

export function ComputerName({
  computer,
  iconOnly = false,
}: {
  computer: Computer;
  iconOnly?: boolean;
}) {
  const names = useStore(computerNames.store);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();
  function save(name: string) {
    try {
      computerNames.rename(computer, name);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(names[computer.key] ?? "");
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size={iconOnly ? "icon-sm" : "sm"}
          title="给电脑命名"
          aria-label={`给 ${computerName(computer, names)} 命名`}
        >
          <Pencil data-icon="inline-start" />
          {!iconOnly && "命名"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>给电脑命名</DialogTitle>
          <DialogDescription>
            起一个容易认出的名字，仅保存在当前浏览器中。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save(value);
          }}
        >
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={id}>电脑名称</FieldLabel>
              <Input
                id={id}
                value={value}
                maxLength={COMPUTER_NAME_LIMIT}
                placeholder="例如：办公室 Mac mini"
                autoComplete="off"
                aria-invalid={!!error}
                aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(undefined);
                }}
              />
              <FieldDescription id={`${id}-hint`} className="break-all">
                原名：{computer.machine.name} · {computerIdentity(computer)}
                。留空将恢复原名。
              </FieldDescription>
              {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
            </Field>
            <DialogFooter>
              {names[computer.key] && (
                <Button type="button" variant="ghost" onClick={() => save("")}>
                  恢复原名
                </Button>
              )}
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  取消
                </Button>
              </DialogClose>
              <Button type="submit">保存名称</Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
