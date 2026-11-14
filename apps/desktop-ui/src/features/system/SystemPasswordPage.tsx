import { useId, useState } from "react";
import {
  clearPasswordMessage,
  setAccessPassword,
  useManagement,
} from "../../core";
import { DesktopIcon } from "../../icons";
import { Badge, Button, Field, IconButton, Input } from "../../primitives";
import { isImeComposing } from "../../primitives/utils";
import type { SystemConfirmAction } from "./SystemOverviewPage";
import { useSystemI18n } from "./system-i18n";

export function SystemPasswordPage({
  onRequestConfirm,
}: {
  onRequestConfirm: (action: SystemConfirmAction) => void;
}) {
  const { ts, tm, computer } = useSystemI18n();
  const state = useManagement();
  const enabled = state.snapshot?.access?.password ?? false;
  const fieldId = useId();

  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const tooShortOrLong =
    password.length > 0 && (password.length < 4 || password.length > 128);
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid =
    password.length >= 4 && password.length <= 128 && confirm === password;

  const closeEditor = () => {
    setEditing(false);
    setPassword("");
    setConfirm("");
    setShowPassword(false);
  };

  const handleSave = async () => {
    if (!valid || state.busy) return;
    if (await setAccessPassword(password)) {
      closeEditor();
    }
  };

  return (
    <div className="ls-system-stack">
      <section className="ls-system-group" aria-label={computer}>
        <div className="ls-system-group__head">
          <h3 className="ls-system-group__title">{computer}</h3>
        </div>

        <div className="ls-system-card">
          <div className="ls-system-row">
            <div className="ls-system-row__copy">
              <span className="ls-system-row__title">
                <DesktopIcon name={enabled ? "lock" : "unlock"} size="sm" />
                {ts("password.rowTitle")}
              </span>
              <span className="ls-system-row__detail">
                {enabled
                  ? ts("password.enabledDetail")
                  : ts("password.disabledDetail")}
              </span>
            </div>
            <div className="ls-system-row__controls">
              <Badge
                tone={enabled ? "ok" : "neutral"}
                dot={enabled ? "ok" : "offline"}
              >
                {enabled
                  ? ts("password.enabledBadge")
                  : ts("password.disabledBadge")}
              </Badge>
              {!editing ? (
                enabled ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={state.busy}
                      onClick={() => {
                        clearPasswordMessage();
                        setEditing(true);
                      }}
                    >
                      {ts("password.changeBtn")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      disabled={state.busy}
                      onClick={() =>
                        onRequestConfirm({ kind: "remove-password" })
                      }
                    >
                      {ts("password.removeBtn")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={state.busy}
                    onClick={() => {
                      clearPasswordMessage();
                      setEditing(true);
                    }}
                  >
                    {ts("password.setBtn")}
                  </Button>
                )
              ) : null}
            </div>
          </div>

          {editing ? (
            <form
              className="ls-system-inline-panel"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <Field
                label={ts("password.newLabel")}
                htmlFor={`${fieldId}-new`}
                error={tooShortOrLong ? ts("password.lengthHint") : undefined}
              >
                <Input
                  id={`${fieldId}-new`}
                  type={showPassword ? "text" : "password"}
                  autoFocus
                  autoComplete="new-password"
                  maxLength={128}
                  value={password}
                  disabled={state.busy}
                  aria-invalid={tooShortOrLong || undefined}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && isImeComposing(event)) {
                      event.preventDefault();
                    }
                  }}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearPasswordMessage();
                  }}
                  trailingSlot={
                    <IconButton
                      icon={showPassword ? "eye-off" : "eye"}
                      size="icon-sm"
                      variant="ghost"
                      label={
                        showPassword
                          ? ts("authModal.hidePassword")
                          : ts("authModal.showPassword")
                      }
                      aria-pressed={showPassword}
                      disabled={state.busy}
                      onClick={() => setShowPassword((prev) => !prev)}
                    />
                  }
                />
              </Field>

              <Field
                label={ts("password.confirmLabel")}
                htmlFor={`${fieldId}-confirm`}
                error={mismatch ? ts("password.mismatch") : undefined}
              >
                <Input
                  id={`${fieldId}-confirm`}
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  maxLength={128}
                  value={confirm}
                  disabled={state.busy}
                  aria-invalid={mismatch || undefined}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && isImeComposing(event)) {
                      event.preventDefault();
                    }
                  }}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    clearPasswordMessage();
                  }}
                />
              </Field>

              <div className="ls-system-inline-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={closeEditor}
                >
                  {ts("modal.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  loading={state.savingPassword}
                  disabled={state.busy || !valid}
                >
                  {state.savingPassword ? ts("modal.saving") : ts("modal.save")}
                </Button>
              </div>
            </form>
          ) : null}
        </div>

        {state.passwordMessage ? (
          <p
            className="ls-system-note"
            data-tone={state.passwordIsError ? "danger" : "ok"}
            role="status"
          >
            {tm(state.passwordMessage)}
          </p>
        ) : null}
        <p className="ls-system-note">{ts("password.footNote")}</p>
      </section>
    </div>
  );
}
