#!/usr/bin/env node
// Development only: evaluates an expression in the window's page over the DevTools port
// (start with `pnpm start -- --remote-debugging-port=<port>`) and prints the JSON result.
//   node scripts/cdp-eval.mjs <port> "<expression>"
//   node scripts/cdp-eval.mjs <port> "<expression>" [page|iframe]
const [port, expression, type = "page"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === type);
if (!page) throw new Error("no page target");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  console.log(JSON.stringify(message.result?.result?.value ?? message.result, null, 2));
  socket.close();
});
