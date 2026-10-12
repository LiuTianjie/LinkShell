import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

type Json = Record<string, unknown>;
export type ModelReply = ({ text: string } | { tool: string; arguments: Json; id: string }) & { finish?: Promise<void> } | { hold: true };
export interface ModelRequest { route: string; body: Json }

/** Only the model's HTTP API is simulated. The CLI, SDK, ACP and host run unchanged. */
export async function modelFixture(reply: (request: ModelRequest) => ModelReply) {
  const requests: ModelRequest[] = [];
  const errors: string[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    try {
      const route = new URL(request.url ?? "/", "http://localhost").pathname;
      if (route.endsWith("/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":100}'); return;
      }
      if (request.method !== "POST" || !["/v1/responses", "/v1/messages"].includes(route)) {
        response.writeHead(404).end(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      const body = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded)
        : request.headers["content-encoding"] === "gzip" ? gunzipSync(encoded) : encoded;
      const received = { route, body: JSON.parse(body.toString()) as Json };
      requests.push(received);
      const result = reply(received);
      if ("hold" in result) {
        // Keep a real inference request in flight until the agent is cancelled.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting for cancellation\n\n");
        held.add(response); response.on("close", () => held.delete(response)); return;
      }
      const id = `fixture_${requests.length}`;
      if (route === "/v1/messages") await anthropic(response, received.body, result, id);
      else await responses(response, result, id);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "api_error", message: errors.at(-1) } }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, errors, held,
    async close() { for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function anthropic(response: ServerResponse, body: Json, reply: Exclude<ModelReply, { hold: true }>, id: string) {
  const tool = "tool" in reply;
  const content = tool ? { type: "tool_use", id: reply.id, name: reply.tool, input: reply.arguments } : { type: "text", text: reply.text };
  const message = { id, type: "message", role: "assistant", model: body.model, content: [content], stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
  if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type: string, data: Json) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  emit("content_block_start", { index: 0, content_block: tool ? { ...content, input: {} } : { type: "text", text: "" } });
  emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(reply.arguments) } : { type: "text_delta", text: reply.text } });
  await reply.finish;
  emit("content_block_stop", { index: 0 });
  emit("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  emit("message_stop", {}); response.end();
}

async function responses(response: ServerResponse, reply: Exclude<ModelReply, { hold: true }>, id: string) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let sequence = 0;
  const emit = (type: string, data: Json) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const item = "tool" in reply
    ? { type: "function_call", id: `fc_${id}`, call_id: reply.id, name: reply.tool, arguments: JSON.stringify(reply.arguments), status: "completed" }
    : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] };
  emit("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...("tool" in reply ? { arguments: "" } : { content: [] }) } });
  if ("text" in reply) {
    emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: reply.text });
    emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: reply.text });
    emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content![0] });
  } else {
    emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
    emit("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments });
  }
  await reply.finish;
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  response.end();
}
