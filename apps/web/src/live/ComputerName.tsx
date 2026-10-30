import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { Pencil } from "lucide-react";
import type { MachineInfo } from "@linkshell/wire";
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
import { engine, type Computer, type Connection } from "./engine";
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
  const [machine, setMachine] = useState<MachineInfo>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const connection = useRef<Connection | undefined>(undefined);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    setLoading(true);
    setSaving(false);
    setError(undefined);
    setMachine(undefined);
    try {
      const retained = engine.retainComputer(computer, { metadataOnly: true });
      release = retained.release;
      connection.current = retained.connection;
      void retained.connection.link.call("machine.info", {}, 15_000).then((info) => {
        if (cancelled) return;
        setMachine(info);
        setValue(info.naming?.configured ? info.naming.customName ?? "" : names[computer.key] ?? "");
        if (!info.naming) setError("请先更新这台电脑上的 LinkShell，更新后即可在所有端同步名称。");
      }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => { if (!cancelled) setLoading(false); });
    } catch (reason) {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    return () => { cancelled = true; connection.current = undefined; release?.(); };
    // Opening takes a snapshot of the previous alias; typing must not reload the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, computer.key]);
  async function save(name: string) {
    const retained = connection.current;
    if (!retained || !machine?.naming || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await computerNames.rename(computer, name, retained.link);
      retained.store.setState({ machine: updated });
      if (connection.current === retained) setOpen(false);
    } catch (reason) {
      if (connection.current === retained) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (connection.current === retained) setSaving(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
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
          className={iconOnly ? "size-5 shrink-0" : undefined}
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
            名称保存在这台电脑上，会同步到已连接的手机和电脑端。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(value);
          }}
        >
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={id}>电脑名称</FieldLabel>
              <Input
                id={id}
                value={value}
                disabled={loading || saving || !machine?.naming}
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
                {loading ? "正在读取电脑名称…" : machine ? `原名：${machine.naming?.defaultName ?? machine.hostname}` : "连接电脑后可读取原名"} · {computerIdentity(computer)}
                。留空将恢复原名。
              </FieldDescription>
              {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
            </Field>
            <DialogFooter>
              {(machine?.naming?.customName || names[computer.key]) && (
                <Button type="button" variant="ghost" disabled={loading || saving || !machine?.naming} onClick={() => void save("")}>
                  恢复原名
                </Button>
              )}
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={saving}>
                  取消
                </Button>
              </DialogClose>
              <Button type="submit" disabled={loading || saving || !machine?.naming}>{saving ? "正在同步…" : "保存名称"}</Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
