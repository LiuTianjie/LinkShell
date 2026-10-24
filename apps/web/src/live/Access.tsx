import { useId, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { useDialogs } from "@/components/Dialogs";
import { useClient, useConnection, useLoad } from "./common";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shown in place of the workspace while the computer waits for its access password. */
export function AccessUnlock({ name }: { name: string }) {
  const unlock = useClient((state) => state.unlock);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = useId();
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await unlock(password);
    } catch (reason) {
      setError(message(reason));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="access-unlock" role="region" aria-labelledby={`${id}-title`}>
      <span className="access-unlock-mark" aria-hidden><Lock size={20} /></span>
      <h2 id={`${id}-title`}>{name} 设置了访问密码</h2>
      <p>输入访问密码后继续。密码在那台电脑上设置。</p>
      <form
        className="access-unlock-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={`${id}-password`} className="sr-only">访问密码</FieldLabel>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            autoFocus
            placeholder="访问密码"
            value={password}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <Button type="submit" disabled={!password || busy}>{busy ? "正在解锁…" : "解锁"}</Button>
      </form>
    </div>
  );
}

/** The current computer's own password; only offered on that computer (the host refuses it remotely). */
export function AccessPasswordSettings() {
  const { link } = useConnection();
  const dialogs = useDialogs();
  const status = useLoad(() => link.call("access.status", {}), [link], 0);
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = useId();
  const enabled = status.value?.password ?? false;
  if (status.error && /unknown method|no handler/.test(message(status.error))) return null;
  const save = async (next: string | undefined) => {
    setBusy(true);
    setError(undefined);
    try {
      await link.call("access.set", next ? { password: next } : {});
      setEditing(false);
      setPassword("");
      setConfirm("");
      await status.reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <div className="access-settings list-row list-row-static">
      <span className="access-settings-mark" data-enabled={enabled || undefined} aria-hidden>
        {enabled ? <Lock size={16} /> : <LockOpen size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">访问密码</div>
        <p className="text-xs text-[var(--tertiaryLabel)]">
          {enabled
            ? "已开启。其他设备切换到这台电脑时，要先输入密码；这台电脑本身不受影响。"
            : "未设置。同一账号或已配对的设备可以直接打开这台电脑。"}
        </p>
        {editing && (
          <form
            className="access-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (password.length >= 4 && !mismatch) void save(password);
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-new`}>{enabled ? "新密码" : "密码"}</FieldLabel>
              <Input id={`${id}-new`} type="password" autoComplete="new-password" autoFocus minLength={4} maxLength={128}
                placeholder="至少 4 位" value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
            <Field data-invalid={mismatch || undefined}>
              <FieldLabel htmlFor={`${id}-confirm`}>再输一次</FieldLabel>
              <Input id={`${id}-confirm`} type="password" autoComplete="new-password" maxLength={128}
                aria-invalid={mismatch || undefined} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
              {mismatch && <FieldError>两次输入不一致</FieldError>}
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || password.length < 4 || confirm !== password}>保存</Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setError(undefined); }}>取消</Button>
            </div>
          </form>
        )}
        {!editing && error && <FieldError>{error}</FieldError>}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" disabled={busy || status.loading} onClick={() => setEditing(true)}>
            {enabled ? "修改" : "设置密码"}
          </Button>
          {enabled && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={async () => {
              if (await dialogs.confirm("移除访问密码？其他设备将可以直接打开这台电脑。")) void save(undefined);
            }}>移除</Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A small lock next to a computer that has an access password. */
export function LockMark({ locked }: { locked?: boolean }) {
  if (!locked) return null;
  return <Lock className="computer-lock-mark" size={12} aria-label="已设置访问密码" />;
}
