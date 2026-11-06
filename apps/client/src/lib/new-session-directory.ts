/** Native menu IDs pass through C strings on iOS, so they cannot contain NUL. */
export const BROWSE_DIRECTORY_ACTION = "linkshell:browse-directory";
export const QUICK_SESSION_ACTION = "linkshell:quick-session";

/** Opening without a project starts in the host's home, never a recently used repository. */
export function newSessionDirectory(selected: string | undefined, home: string | undefined): string {
  return selected || home || "";
}
