import type { HostLink } from "@linkshell/client-core";

type TerminalLink = Pick<HostLink, "call" | "status">;

// The host keeps one output listener per connection and terminal, so one detach
// ends the stream for everyone on this phone: the terminal screen and the watch.
const holders = new WeakMap<TerminalLink, Map<string, number>>();

/**
 * Marks a terminal as wanted by one more user of this connection (each attaches
 * itself, with its own replay). Releasing the last hold detaches it on the host.
 */
export function holdTerminal(link: TerminalLink, terminalId: string): () => void {
  let counts = holders.get(link);
  if (!counts) holders.set(link, (counts = new Map()));
  counts.set(terminalId, (counts.get(terminalId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(terminalId) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(terminalId, remaining);
      return;
    }
    counts.delete(terminalId);
    // Offline the host already dropped the listener; a detach queued for the next
    // connection would only cancel whoever attaches there first.
    if (link.status === "online") void link.call("terminals.detach", { terminalId }).catch(() => {});
  };
}
