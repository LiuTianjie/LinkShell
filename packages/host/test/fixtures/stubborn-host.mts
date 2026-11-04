// A host in a process of its own, so a test can SIGKILL it the way a crash would,
// or SIGTERM it for the CLI's clean shutdown. argv: home, the stubborn agent's path.
import { AcpDriver } from "../../src/drivers/acp/driver.js";
import { startHost } from "../../src/host.js";

const [home, agent] = process.argv.slice(2);
const host = await startHost({
  home,
  version: "test",
  drivers: () => [new AcpDriver({ id: "stubborn", label: "Stubborn", tier: "remote", command: agent!, args: [], version: { command: agent!, args: ["--version"] }, discover: true }, { env: process.env, hostVersion: "test" })],
  log: (message) => process.stderr.write(`${message}\n`),
});
process.on("SIGTERM", () => void host.stop().then(() => process.exit(0)));
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
