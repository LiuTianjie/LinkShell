/** The gateway as typed, made into an address a connection can be opened to; undefined when it isn't one. */
export function gatewayAddress(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  if (!/^(wss?|https?):\/\//i.test(withScheme)) return undefined;
  try {
    return new URL(withScheme.replace(/^ws/i, "http")).hostname ? withScheme : undefined;
  } catch {
    return undefined;
  }
}
