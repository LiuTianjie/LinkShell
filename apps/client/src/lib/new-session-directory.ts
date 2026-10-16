/** Native menu IDs pass through C strings on iOS, so they cannot contain NUL. */
export const BROWSE_DIRECTORY_ACTION = "linkshell:browse-directory";

/** A new computer needs a working directory even before it has any project history. */
export function newSessionDirectory(selected: string | undefined, projects: readonly { cwd: string }[], home: string | undefined): string {
  return selected || projects[0]?.cwd || home || "";
}
