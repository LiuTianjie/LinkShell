const prefix = "screen:";

export function screenView(computerKey: string): string {
  return prefix + computerKey;
}

export function screenComputerKey(view: string): string | undefined {
  return view.startsWith(prefix) && view.length > prefix.length
    ? view.slice(prefix.length)
    : undefined;
}
