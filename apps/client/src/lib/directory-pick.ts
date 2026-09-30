// Hands the directory picked in the browser sheet back to the sheet that opened it.

type Listener = (path: string) => void;
const listeners = new Set<Listener>();

export function onDirectoryPicked(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pickDirectory(path: string): void {
  for (const listener of listeners) listener(path);
}
