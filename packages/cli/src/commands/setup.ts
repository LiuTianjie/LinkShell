import * as readline from "node:readline";
import { isLoggedIn, loadAuth } from "../auth.js";
import { assertHostRuntime, ensureHostRunning, joinGatewayAfterLogin, OFFICIAL_GATEWAY, readHostConfig, sameGateway, withRunningHost, writeHostConfig } from "./host.js";
import { setUpScreen } from "./screen.js";

// `linkshell setup`: everything a new installation needs, once, in order —
// the host running, the screen's permissions, a phone that can reach this
// computer. Someone who installs and never comes back to the terminal should
// leave with all of it done: the first `linkshell host --daemon` runs this by
// itself (see `offerSetup`).

const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

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

/** The phone's way to this computer: an account both are signed in to, or a pairing through a gateway. */
async function setUpPhone(out: (line?: string) => void, interactive: boolean): Promise<boolean> {
  const gateway = await withRunningHost((client) => client.call("gateway.status", {}));
  // The account counts on LinkShell's own gateway only; with a gateway of one's own, phones are paired.
  const official = !gateway || gateway.status === "off" || !gateway.url || sameGateway(gateway.url, OFFICIAL_GATEWAY);
  if (isLoggedIn() && official) {
    const email = loadAuth()?.email;
    if (gateway?.status === "online") {
      out(`  ${green("✓")} Signed in${email ? ` as ${email}` : ""}: this computer is online.`);
      out(dim("    Open LinkShell on your phone and sign in with the same account — it shows up there, no pairing needed."));
      return true;
    }
    // Signed in, not online yet (a host started before the login, or no subscription): say which.
    await joinGatewayAfterLogin("pro");
    return (await withRunningHost((client) => client.call("gateway.status", {})))?.status === "online";
  }
  if (gateway && gateway.status !== "off" && gateway.devices.length > 0) {
    out(`  ${green("✓")} Paired with ${gateway.devices.map((device) => device.name).join(", ")}.`);
    return true;
  }
  if (gateway && gateway.status !== "off") {
    out("  This computer uses your own gateway. Pair your phone with:  linkshell pair");
    return false;
  }
  if (!interactive) {
    out("  Not connected to a phone yet: linkshell login (LinkShell account), or your own gateway and linkshell pair.");
    return false;
  }
  out("  Your phone reaches this computer through your LinkShell account (Pro), from anywhere.");
  const answer = await ask("  Sign in now? It opens your browser. [Y/n] ");
  if (answer === "n" || answer === "no") {
    out(dim("    Later: linkshell login — or with your own gateway: linkshell host --gateway <url>, then linkshell pair"));
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
  const out = (line = "") => process.stdout.write(`${line}\n`);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  assertHostRuntime();
  out(`\n  ${bold("LinkShell setup")}${from === "first-start" ? dim("  (first start on this computer; again any time with: linkshell setup)") : ""}\n`);

  out(`  ${bold("1")}  The host`);
  await ensureHostRunning();
  out(`  ${green("✓")} Running (${version}); it keeps running in the background.\n`);

  out(`  ${bold("2")}  The screen ${dim("— watch and control this computer from the phone")}`);
  const screen = await setUpScreen(out, interactive);
  out();

  out(`  ${bold("3")}  Your phone`);
  const phone = await setUpPhone(out, interactive);
  out();

  // Run where nobody could answer, it has set nothing up: the first start at a terminal still offers it.
  if (interactive) await remember("done");
  if (screen && phone) out(`  ${green("All set.")} Open LinkShell on your phone.\n`);
  else out(`  Done for now. ${[!screen && "The screen: linkshell screen", !phone && "The phone: linkshell login, or linkshell pair"].filter(Boolean).join(" · ")}\n`);
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
