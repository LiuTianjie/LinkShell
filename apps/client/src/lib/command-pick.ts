// Hands the command picked in the commands sheet back to the composer of the session that opened it.

type Listener = (sessionId: string, name: string) => void;
const listeners = new Set<Listener>();

export function onCommandPicked(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pickCommand(sessionId: string, name: string): void {
  for (const listener of listeners) listener(sessionId, name);
}
