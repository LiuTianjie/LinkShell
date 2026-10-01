import type { GitInfo } from "@linkshell/wire";
import { useEffect, useState } from "react";
import { useActions, useClient } from "./client";

/** A worktree's branch as the app shows it: without LinkShell's own prefix, its middle cut when long. */
export function branchLabel(branch: string, max = 22): string {
  const name = branch.replace(/^linkshell\//, "");
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
}

/** The branch to show for a directory: the one checked out, or the commit on a detached HEAD. */
export function branchOf(git: GitInfo | undefined): string | undefined {
  return git?.branch ?? git?.head;
}

/**
 * What git says about a directory on the computer: undefined when it isn't a
 * repository (or isn't known yet). Asked again whenever `refresh` changes;
 * what was known stays on screen meanwhile.
 */
export function useGitInfo(path: string | undefined, refresh = 0): GitInfo | undefined {
  const { gitInfo } = useActions();
  const online = useClient((state) => state.status === "online");
  const [git, setGit] = useState<{ path: string; info: GitInfo | undefined } | null>(null);
  useEffect(() => {
    if (!path || !online) return;
    let cancelled = false;
    gitInfo(path).then(
      (info) => !cancelled && setGit({ path, info }),
      () => !cancelled && setGit({ path, info: undefined }),
    );
    return () => {
      cancelled = true;
    };
  }, [gitInfo, path, online, refresh]);
  return git && git.path === path ? git.info : undefined;
}
