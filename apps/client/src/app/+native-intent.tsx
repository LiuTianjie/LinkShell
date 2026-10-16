// Android delivers the OAuth redirect to the app as well as to the browser
// session waiting for it; that session reads it, there is no page to open.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    const url = new URL(path, "linkshell:///");
    const internal = url.protocol === "linkshell:" || url.protocol === "linkshell-dev:";
    const route = `${url.host ? `/${url.host}` : ""}${url.pathname}`;
    if (internal && route === "/auth-callback") return null;
    // Expo's custom-scheme parser decodes query values before parsing the route.
    // Our computer keys contain '#', so that would turn the machine and session
    // into a fragment. A relative path bypasses that lossy scheme conversion.
    if (internal && route === "/activity") return `${route}${url.search}`;
  } catch {
    // Opening the app matters more than this.
  }
  return path;
}
