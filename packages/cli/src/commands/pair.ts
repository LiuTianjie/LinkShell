import qrcode from "qrcode-terminal";
import type { HostClient } from "@linkshell/host";

// `linkshell pair`: show a QR code (and a code to type) that lets a phone reach
// this computer through the gateway, then wait for it to pair.

export async function runPair(): Promise<void> {
  const { ensureHostRunning, assertHostRuntime } = await import("./host.js");
  assertHostRuntime();
  const { connectHost } = await import("@linkshell/host");
  const socket = await ensureHostRunning();
  const client = await connectHost(socket);
  try {
    const status = await client.call("gateway.status", {});
    if (status.status === "off") {
      const { isLoggedIn } = await import("../auth.js");
      process.stderr.write(
        isLoggedIn()
          ? "\n  The running host started before you logged in. Restart it to use the official gateway:\n\n    linkshell host stop && linkshell host --daemon\n\n"
          : "\n  Pairing goes through a gateway. Either log in with a Pro account (official gateway):\n\n    linkshell login\n\n  or use your own:\n\n    linkshell host --gateway wss://your-gateway\n\n",
      );
      process.exitCode = 1;
      return;
    }
    let offer;
    try {
      offer = await client.call("pairing.start", {}, 20_000);
    } catch (error) {
      process.stderr.write(`\n  Couldn't start pairing: ${error instanceof Error ? error.message : String(error)}\n\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("\n  Scan with the LinkShell app (电脑 → 添加电脑):\n\n");
    qrcode.generate(offer.link, { small: true }, (art) => process.stdout.write(`${art.replace(/^/gm, "  ")}\n`));
    const code = `${offer.code.slice(0, 3)} ${offer.code.slice(3)}`;
    const minutes = Math.round((offer.expiresAt - Date.now()) / 60_000);
    process.stdout.write(`\n  Or enter the code:  ${code}   (valid ${minutes} min, gateway ${offer.gateway})\n\n  Waiting for your phone…`);
    const outcome = await waitForPairing(client, offer.expiresAt);
    process.stdout.write(typeof outcome === "object" ? `\r  ✓ Paired with ${outcome.name}. It can reach this computer from anywhere now.\n\n` : "\r  Pairing window closed.            \n\n");
    // What a shell expects of a command ended by Ctrl-C.
    if (outcome === "interrupted") process.exitCode = 130;
  } finally {
    client.close();
  }
}

/** Waits for a phone to pair: the device, or why the wait ended without one. */
export function waitForPairing(client: Pick<HostClient, "on">, expiresAt: number): Promise<{ name: string } | "expired" | "interrupted"> {
  return new Promise((resolve) => {
    // However the wait ends, the timer and the listeners end with it: a pending timer keeps the process alive until
    // the window closes, and a SIGINT listener left behind swallows every later Ctrl-C.
    const finish = (outcome: { name: string } | "expired" | "interrupted") => {
      stop();
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      resolve(outcome);
    };
    const stop = client.on("pairing.done", ({ device }) => finish(device));
    const timer = setTimeout(() => finish("expired"), expiresAt - Date.now());
    const interrupt = () => finish("interrupted");
    process.on("SIGINT", interrupt);
  });
}
