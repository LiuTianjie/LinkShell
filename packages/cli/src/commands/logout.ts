import { clearAuth, loadAuth } from "../auth.js";

export function runLogout(): void {
  const auth = loadAuth();
  if (!auth || !auth.accessToken) {
    process.stderr.write("\n  Not currently logged in.\n\n");
    return;
  }

  clearAuth();
  process.stderr.write(`\n  \x1b[32m✓\x1b[0m Logged out${auth.email ? ` (${auth.email})` : ""}.\n\n`);
}
