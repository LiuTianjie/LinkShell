// The screen viewer on its own, without a host or a phone: serves the viewer
// page on loopback and prints its address, for a browser on this computer (or
// a simulator, which shares its loopback).
//
//   LINKSHELL_INPUT_DRY_RUN=1 pnpm tsx scripts/screen-dev.ts [--stun <url>]… [--for <seconds>]
//
// With LINKSHELL_INPUT_DRY_RUN=1 nothing is posted to the system: what would
// have been is logged. LINKSHELL_SCREEN_CLOCK=1 has the app show the clock
// strip the page's `?measure=1` reads latency from.
import { ScreenShare } from "../src/screen.js";

const args = process.argv.slice(2);
const stun: string[] = [];
let seconds = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--stun") stun.push(args[++i]!);
  else if (args[i] === "--for") seconds = Number(args[++i]);
}

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${message}`);
const screen = new ScreenShare(log, () => stun);
const { port, token, displays } = await screen.start();
log(`displays: ${displays.map((display) => `${display.index} ${display.name}`).join(", ")}`);
console.log(`http://127.0.0.1:${port}/?token=${token}&display=${displays[0]!.index}`);

const end = () => {
  screen.stop();
  process.exit(0);
};
process.on("SIGINT", end);
process.on("SIGTERM", end);
if (seconds > 0) setTimeout(end, seconds * 1000);
