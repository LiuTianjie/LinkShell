// A stdio MCP server with one page (an MCP App), for the Claude MCP Apps tests.
import { createInterface } from "node:readline";

const PAGE = "ui://demo/screen.html";
const tools = [
  { name: "show_screen", title: "Demo Screen", description: "Shows the screen", inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: PAGE } } },
  { name: "screen_frame", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
  { name: "model_only", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
  { name: "needs_input", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, _meta: { ui: { resourceUri: "ui://demo/other.html" } } },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "demo", version: "1" } });
    case "tools/list":
      return reply({ tools });
    case "resources/read":
      return reply({ contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: `<html>${process.env.DEMO_MARK ?? ""}</html>`, _meta: { ui: { prefersBorder: false } } }] });
    case "tools/call":
      return reply({ content: [{ type: "text", text: `ran ${message.params.name}` }], structuredContent: { tool: message.params.name } });
    default:
      return send({ id: message.id, error: { code: -32601, message: "no" } });
  }
});
