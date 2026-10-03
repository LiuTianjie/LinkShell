// Android delivers the OAuth redirect to the app as well as to the browser
// session waiting for it; that session reads it, there is no page to open.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    if (/^(?:linkshell:\/\/)?\/?auth-callback\b/.test(path)) return null;
  } catch {
    // Opening the app matters more than this.
  }
  return path;
}
