import { stateLabel } from "./common";

// The state table in docs/design/visual-system.md: colour only for running, waiting on the person and
// errors. Idle and finished are the normal state and stay grey, as do offline and unknown.
// Connection health is its own scale, where reachable is the one green.
const tone = (state: string) =>
  ["error", "failed"].includes(state)
    ? "var(--danger)"
    : ["waiting", "blocked"].includes(state)
      ? "var(--waiting)"
      : ["running", "active"].includes(state)
        ? "var(--running)"
        : state === "online"
          ? "var(--ok)"
          : "var(--idle)";

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
        className="size-[8px] shrink-0 rounded-full"
        style={{ background: tone(state) }}
      />
      {label ?? stateLabel(state)}
    </span>
  );
}
