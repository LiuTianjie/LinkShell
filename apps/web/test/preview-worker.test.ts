import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../public/preview/worker.js", import.meta.url),
  "utf8",
);
function worker(hasBridge = true) {
  const listeners = new Map<string, (event: any) => void>();
  const postMessage = vi.fn((message, ports) => {
    if (message.type === "restore")
      ports[0].postMessage({ bootstrap: "function() {}" });
    else {
      ports[0].postMessage({
        type: "http-head",
        status: 200,
        headers: [["content-type", "text/plain"]],
      });
      ports[0].postMessage({
        type: "http-chunk",
        body: new TextEncoder().encode(message.path).buffer,
      });
      ports[0].postMessage({ type: "http-end" });
    }
    ports[0].close();
  });
  const bridge = {
    id: "bridge",
    url: "https://preview.test/preview/bridge.html#token",
    postMessage,
  };
  const page = { id: "page", url: "https://preview.test/preview/view/token/" };
  const fallback = vi.fn(async () => new Response("static"));
  runInNewContext(source, {
    self: {
      location: { origin: "https://preview.test" },
      addEventListener: (name: string, listener: any) =>
        listeners.set(name, listener),
    },
    clients: {
      matchAll: async () => (hasBridge ? [bridge, page] : [page]),
      get: async (id: string) =>
        id === "page"
          ? page
          : hasBridge && id === "bridge"
            ? bridge
            : undefined,
    },
    URL,
    Response,
    Request,
    Headers,
    MessageChannel,
    ReadableStream,
    TextEncoder,
    Uint8Array,
    crypto,
    setTimeout,
    clearTimeout,
    fetch: fallback,
  });
  async function request(path: string, clientId = "", resultingClientId = "") {
    let response: Promise<Response> | undefined;
    listeners.get("fetch")!({
      request: new Request("https://preview.test" + path),
      clientId,
      resultingClientId,
      respondWith: (value: Promise<Response>) => (response = value),
    });
    return response!;
  }
  return { request, postMessage, fallback };
}

it("restores a preview navigation in a fresh worker", async () => {
  const w = worker();
  const response = await w.request("/preview/view/token/settings", "", "page");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("/settings");
  expect(w.postMessage.mock.calls[0][0]).toEqual({
    type: "restore",
    token: "token",
  });
  expect(w.fallback).not.toHaveBeenCalled();
});

it("recovers root-relative resources from their preview client after memory is lost", async () => {
  const w = worker();
  const response = await w.request("/api?item=1", "page");
  expect(await response.text()).toBe("/api?item=1");
  const next = await w.request("/hello.js", "page");
  expect(await next.text()).toBe("/hello.js");
  expect(
    w.postMessage.mock.calls.filter(([message]) => message.type === "restore"),
  ).toHaveLength(1);
});

it("deduplicates recovery across concurrent resources", async () => {
  const w = worker();
  const responses = await Promise.all([
    w.request("/a", "page"),
    w.request("/b", "page"),
  ]);
  expect(
    await Promise.all(responses.map((response) => response.text())),
  ).toEqual(["/a", "/b"]);
  expect(
    w.postMessage.mock.calls.filter(([message]) => message.type === "restore"),
  ).toHaveLength(1);
});

it("reports a closed bridge instead of serving the static site inside the preview", async () => {
  const w = worker(false);
  expect((await w.request("/preview/view/token/")).status).toBe(503);
  expect(w.fallback).not.toHaveBeenCalled();
});

it("leaves unowned static requests alone", async () => {
  const w = worker();
  expect(await (await w.request("/preview/bridge.html")).text()).toBe("static");
  expect(w.postMessage).not.toHaveBeenCalled();
});
