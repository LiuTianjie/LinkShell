import { createConnection, type Socket } from "node:net";

/**
 * Probes candidate direct fusion hosts in parallel while preserving preference order:
 * - Resolves immediately when candidate `i` connects and all higher-priority `0..i-1` have failed.
 * - Grants higher-priority still-pending candidates a brief `graceMs` window when a lower-priority
 *   candidate connects first, so dead subnet IPs never add `650ms * N` serial latency before tunnel setup.
 */
export function pickDirectFusionHost(
  hosts: readonly string[],
  port: number,
  options: { timeoutMs?: number; graceMs?: number; connect?: (host: string, port: number) => Socket } = {},
): Promise<string | undefined> {
  const candidates = hosts.filter((h) => h.length > 0);
  if (candidates.length === 0) return Promise.resolve(undefined);
  const timeoutMs = options.timeoutMs ?? 400;
  const graceMs = options.graceMs ?? 60;
  const connect = options.connect ?? ((host: string, p: number) => createConnection({ host, port: p }));

  return new Promise((resolve) => {
    let settled = false;
    const states: Array<"pending" | "ok" | "fail"> = candidates.map(() => "pending");
    const sockets: Socket[] = [];
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (winner?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      for (const sock of sockets) sock.destroy();
      resolve(winner);
    };

    const evaluate = (allowGraceWinner: boolean) => {
      if (settled) return;
      for (let i = 0; i < candidates.length; i++) {
        if (states[i] === "ok") {
          finish(candidates[i]);
          return;
        }
        if (states[i] === "pending" && !allowGraceWinner) {
          if (!graceTimer && states.some((s) => s === "ok")) {
            graceTimer = setTimeout(() => evaluate(true), graceMs);
          }
          return;
        }
      }
      if (allowGraceWinner || states.every((s) => s === "fail")) finish(undefined);
    };

    const hardTimer = setTimeout(() => evaluate(true), timeoutMs);

    candidates.forEach((candidate, idx) => {
      const sock = connect(candidate, port);
      sockets.push(sock);
      sock.once("connect", () => {
        if (states[idx] !== "pending") return;
        states[idx] = "ok";
        sock.destroy();
        evaluate(false);
      });
      sock.once("error", () => {
        if (states[idx] !== "pending") return;
        states[idx] = "fail";
        sock.destroy();
        evaluate(false);
      });
    });
  });
}
