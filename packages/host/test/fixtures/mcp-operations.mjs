import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "notifications/cancelled") return;
  if (request.method === "wait") return;
  if (request.method === "null") { send({ id: request.id, result: null }); return; }
  if (request.method === "error") { send({ id: request.id, error: { code: -32000, message: "MCP error", data: null, extension: "preserved" } }); return; }
  const token = request.params?._meta?.progressToken;
  if (token !== undefined) send({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1 } });
  setTimeout(() => send({ id: request.id, result: { requestId: request.id, echo: request.params, content: [{ type: "text", text: "中文" }] } }), 5);
});
