import * as readline from "node:readline";
import { isLoggedIn, loadAuth } from "../auth.js";
import { isHeadlessSession, stdoutStyle } from "../utils/format.js";
import {
  assertHostRuntime,
  ensureHostRunning,
  joinGatewayAfterLogin,
  OFFICIAL_GATEWAY,
  readHostConfig,
  sameGateway,
  withRunningHost,
  writeHostConfig,
} from "./host.js";
import { setUpScreen } from "./screen.js";

// `linkshell setup`: everything a new installation needs, once, in order —
// the host running, the screen's permissions, a phone that can reach this
// computer. Someone who installs and never comes back to the terminal should
// leave with all of it done: the first `linkshell host --daemon` runs this by
// itself (see `offerSetup`).

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    }),
  );
}

async function home(): Promise<string> {
  const { defaultHome } = await import("@linkshell/host");
  return defaultHome();
}

/** Whether this installation has been through setup (or said no to it). */
export async function setupDone(): Promise<boolean> {
  return readHostConfig(await home()).setup !== undefined;
}

async function remember(outcome: "done"): Promise<void> {
  const at = await home();
  writeHostConfig(at, { ...readHostConfig(at), setup: outcome });
}

async function setUpHost(version: string, out: (line?: string) => void, interactive: boolean): Promise<void> {
  const style = stdoutStyle();
  if (process.platform === "linux") {
    try {
      const { getServiceStatus, isSystemdUserAvailable, runInstallService } = await import("./service.js");
      if (await isSystemdUserAvailable()) {
        const status = await getServiceStatus({ platform: "linux" });
        if (status.installed && status.running) {
          out(`  ${style.green("✓")} Running (${version}) via systemd --user (${status.serviceName}).`);
          if (status.linger === false) {
            out(style.yellow("    ! User linger is disabled — run `sudo loginctl enable-linger $USER` so SSH logout won't stop the host."));
          }
          out();
          return;
        }
        if (interactive && !status.installed) {
          out("  systemd --user is available on this Linux machine.");
          const answer = await ask("  Install as a systemd --user service (auto-start on boot & survive SSH logout)? [Y/n] ");
          if (answer !== "n" && answer !== "no") {
            try {
              await runInstallService({ platform: "linux" });
              return;
            } catch (error) {
              out(`  ${style.yellow("!")} Could not install systemd service (${error instanceof Error ? error.message : String(error)}); falling back to background daemon.`);
            }
          }
        }
      }
    } catch {
      // Fall back to standard background daemon below.
    }
  }
  await ensureHostRunning();
  out(`  ${style.green("✓")} Running (${version}); it keeps running in the background.`);
  if (process.platform === "linux") {
    out(style.dim("    Tip: run `linkshell host install-service` to auto-start with systemd --user."));
  }
  out();
}

/** The phone's way to this computer: an account both are signed in to, or a pairing through a gateway. */
async function setUpPhone(out: (line?: string) => void, interactive: boolean): Promise<boolean> {
  const style = stdoutStyle();
  const gateway = await withRunningHost((client) => client.call("gateway.status", {}));
  // The account counts on LinkShell's own gateway only; with a gateway of one's own, phones are paired.
  const official = !gateway || gateway.status === "off" || !gateway.url || sameGateway(gateway.url, OFFICIAL_GATEWAY);
  if (isLoggedIn() && official) {
    const email = loadAuth()?.email;
    if (gateway?.status === "online") {
      out(`  ${style.green("✓")} Signed in${email ? ` as ${email}` : ""}: this computer is online.`);
      out(style.dim("    Open LinkShell on your phone and sign in with the same account — it shows up there, no pairing needed."));
      return true;
    }
    // Signed in, not online yet (a host started before the login, or no subscription): say which.
    await joinGatewayAfterLogin("pro");
    return (await withRunningHost((client) => client.call("gateway.status", {})))?.status === "online";
  }
  if (gateway && gateway.status !== "off" && gateway.devices.length > 0) {
    out(`  ${style.green("✓")} Paired with ${gateway.devices.map((device) => device.name).join(", ")}.`);
    return true;
  }
  if (gateway && gateway.status !== "off") {
    out("  This computer uses your own gateway. Pair your phone with:  linkshell pair");
    return false;
  }
  if (!interactive) {
    out("  Not connected to a phone yet: linkshell login (official gateway with iTool membership), linkshell host --lan (same Wi-Fi), or your own gateway and linkshell pair.");
    return false;
  }
  out("  Your phone reaches this computer from anywhere through the official gateway:");
  out("  • Sign in: connect through the official gateway with an iTool membership.");
  out(style.dim("  • Free alternatives: same-Wi-Fi LAN (linkshell host --lan) or self-hosted gateway (linkshell host --gateway <url> && linkshell pair)."));
  const headless = isHeadlessSession();
  const answer = await ask(
    headless
      ? "  Sign in now to connect your account? (email/password or browser link) [Y/n] "
      : "  Sign in now to connect your account? It opens your browser. [Y/n] ",
  );
  if (answer === "n" || answer === "no") {
    out(style.dim("    Later: linkshell login — LAN: linkshell host --lan — Self-hosted: linkshell host --gateway <url>, then linkshell pair"));
    return false;
  }
  const { runLogin } = await import("./login.js");
  const result = await runLogin();
  if (!result) return false;
  await joinGatewayAfterLogin(result.plan);
  return (await withRunningHost((client) => client.call("gateway.status", {})))?.status === "online";
}

/** The whole of it. `from`: who is running it — said aloud only when it wasn't asked for. */
export async function runSetup(version: string, from: "command" | "first-start" = "command"): Promise<void> {
  const style = stdoutStyle();
  const out = (line = "") => process.stdout.write(`${line}\n`);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  assertHostRuntime();
  out(`\n  ${style.bold("LinkShell setup")}${from === "first-start" ? style.dim("  (first start on this computer; again any time with: linkshell setup)") : ""}\n`);

  out(`  ${style.bold("1")}  The host`);
  await setUpHost(version, out, interactive);

  out(`  ${style.bold("2")}  The screen ${style.dim("— watch and control this computer from the phone")}`);
  const screen = await setUpScreen(out, interactive, { optionalHeadless: true });
  out();

  out(`  ${style.bold("3")}  Your phone`);
  const phone = await setUpPhone(out, interactive);
  out();

  // Run where nobody could answer, it has set nothing up: the first start at a terminal still offers it.
  if (interactive) await remember("done");
  if (screen && phone) out(`  ${style.green("All set.")} Open LinkShell on your phone.\n`);
  else out(`  Done for now. ${[!screen && "The screen: linkshell screen", !phone && "The phone: linkshell login, linkshell host --lan, or linkshell pair"].filter(Boolean).join(" · ")}\n`);
}

/**
 * The first start on a computer: the host has just been started by someone at
 * a terminal, and nothing has ever been set up here. Rather than leave the
 * rest for the day it is needed (by then nobody is at the computer), it is
 * done now. Once: a second start says nothing.
 */
export async function offerSetup(version: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true || (await setupDone())) return false;
  await runSetup(version, "first-start");
  return true;
}
