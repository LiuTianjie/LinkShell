import qrcode from "qrcode-terminal";
import type { HostClient } from "@linkshell/host";
import { stdoutStyle } from "../utils/format.js";

// `linkshell pair`: show a QR code (and a code to type) that lets a phone reach
// this computer through the gateway, then wait for it to pair.

export interface RunPairOptions {
  noQr?: boolean;
  json?: boolean;
}

/** Measures the widest rendered line in a QR ASCII block (counting 2 leading indent spaces). */
export function qrMaxLineWidth(art: string): number {
  let max = 0;
  for (const line of art.split(/\r?\n/)) {
    if (line.length > max) max = line.length;
  }
  return max + 2;
}

/** Suppresses QR art when `--no-qr` is set or the terminal is narrower than the QR width. */
export function shouldRenderQr(art: string, columns?: number, noQr = false): boolean {
  if (noQr) return false;
  if (typeof columns === "number" && columns > 0 && qrMaxLineWidth(art) > columns) return false;
  return true;
}

function generateQrArt(link: string): string {
  let output = "";
  qrcode.generate(link, { small: true }, (art) => {
    output = art;
  });
  return output;
}

export async function runPair(options: RunPairOptions = {}): Promise<void> {
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
          ? "\n  The running host started before you logged in. Restart it to use the official gateway:\n\n    linkshell host restart\n\n"
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

    const code = `${offer.code.slice(0, 3)} ${offer.code.slice(3)}`;
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            code: offer.code,
            formattedCode: code,
            link: offer.link,
            gateway: offer.gateway,
            expiresAt: offer.expiresAt,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const style = stdoutStyle();
    const art = options.noQr ? "" : generateQrArt(offer.link);
    const cols = process.stdout.columns;
    if (!options.noQr && shouldRenderQr(art, cols, false)) {
      process.stdout.write("\n  Scan with the LinkShell app (电脑 → 添加电脑):\n\n");
      process.stdout.write(`${art.replace(/^/gm, "  ")}\n`);
    } else if (!options.noQr && typeof cols === "number" && cols > 0) {
      process.stdout.write(
        `\n  ${style.dim(`Terminal is narrower than QR code (${cols} cols); enter the pairing code below (or use --json).`)}\n`,
      );
    } else {
      process.stdout.write("\n  Enter this pairing code in the LinkShell app (电脑 → 添加电脑):\n");
    }

    const minutes = Math.max(1, Math.round((offer.expiresAt - Date.now()) / 60_000));
    process.stdout.write(`\n  Pairing code:  ${style.bold(code)}   (valid ${minutes} min, gateway ${offer.gateway})\n`);
    if (options.noQr || !shouldRenderQr(art, cols, options.noQr)) {
      process.stdout.write(`  Pairing link:  ${offer.link}\n`);
    }
    process.stdout.write("\n  Waiting for your phone…");

    const outcome = await waitForPairing(client, offer.expiresAt);
    const clearLine = process.stdout.isTTY ? "\r\x1b[2K" : "\n";
    if (typeof outcome === "object") {
      process.stdout.write(`${clearLine}  ${style.green("✓")} Paired with ${outcome.name}. It can reach this computer from anywhere now.\n\n`);
    } else if (outcome === "expired") {
      process.stdout.write(`${clearLine}  Pairing window expired.\n\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${clearLine}  Pairing cancelled.\n\n`);
      // What a shell expects of a command ended by Ctrl-C.
      process.exitCode = 130;
    }
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
    const timer = setTimeout(() => finish("expired"), Math.max(0, expiresAt - Date.now()));
    const interrupt = () => finish("interrupted");
    process.on("SIGINT", interrupt);
  });
}
