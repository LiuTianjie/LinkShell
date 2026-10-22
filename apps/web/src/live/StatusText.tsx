import { stateLabel } from "./common";

const tone = (state: string) =>
  ["error", "failed"].includes(state)
    ? "var(--danger)"
    : ["waiting", "pending", "blocked"].includes(state)
      ? "var(--warning)"
      : ["running", "active"].includes(state)
        ? "var(--running)"
        : ["idle", "completed", "complete"].includes(state)
          ? "var(--idle, var(--success))"
          : "var(--tertiaryLabel)";

/** Dot + text status; the colour comes only from semantic variables. */
export function StatusText({
  state,
  label,
}: {
  state: string;
  label?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-[var(--secondaryLabel)]">
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: tone(state) }}
      />
      {label ?? stateLabel(state)}
    </span>
  );
}
