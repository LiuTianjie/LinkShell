import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import {
  isAllowedProxyHost,
  normalizePreviewSubPath,
  RemotePortProxyManager,
  validatePreviewPort,
} from "../dist/main/remote-port-proxy.js";

test("normalizePreviewSubPath and validatePreviewPort sanitize paths and guard internal ports", () => {
  assert.equal(normalizePreviewSubPath(undefined), "/");
  assert.equal(normalizePreviewSubPath(""), "/");
  assert.equal(normalizePreviewSubPath("api/health?x=1"), "/api/health?x=1");
  assert.equal(normalizePreviewSubPath("/app\r\nSet-Cookie: bad=1"), "/appSet-Cookie: bad=1");
  assert.equal(normalizePreviewSubPath("http://127.0.0.1:8765/docs/getting-started?tab=2#top"), "/docs/getting-started?tab=2#top");

  assert.equal(validatePreviewPort(8765, 51234), 8765);
  assert.equal(validatePreviewPort("3000", 51234), 3000);
  assert.throws(() => validatePreviewPort(0), /无效的预览端口号/);
  assert.throws(() => validatePreviewPort(70_000), /无效的预览端口号/);
  assert.throws(() => validatePreviewPort(51234, 51234), /不允许打开工作台内部服务端口/);
});

test("RemotePortProxyManager reuses loopback server per computerKey+port and proxies GET/POST/HEAD/redirects", async (t) => {
  const seenRequests = [];
  const manager = new RemotePortProxyManager({
    dispatch(payload) {
      seenRequests.push(payload);
      queueMicrotask(() => {
        if (payload.path === "/redirect") {
          manager.reply({
            reqId: payload.reqId,
            status: 302,
            headers: [
              ["location", `http://localhost:${payload.port}/dashboard?ok=1`],
              ["transfer-encoding", "chunked"],
              ["connection", "close"],
            ],
            bodyBase64: "",
          });
          return;
        }
        if (payload.method === "POST") {
          const echoed = Buffer.concat([
            Buffer.from("echo:", "utf8"),
            Buffer.from(payload.bodyBase64, "base64"),
          ]);
          manager.reply({
            reqId: payload.reqId,
            status: 201,
            headers: [
              ["content-type", "application/octet-stream"],
              ["set-cookie", "a=1; Path=/"],
              ["set-cookie", "b=2; Path=/"],
              ["transfer-encoding", "chunked"],
            ],
            bodyBase64: echoed.toString("base64"),
          });
          return;
        }
        const html = Buffer.from(`<h1>remote:${payload.computerKey}:${payload.port}${payload.path}</h1>`, "utf8");
        manager.reply({
          reqId: payload.reqId,
          status: 200,
          headers: [
            ["content-type", "text/html; charset=utf-8"],
            ["transfer-encoding", "chunked"],
          ],
          bodyBase64: html.toString("base64"),
        });
      });
      return true;
    },
  });
  t.after(() => manager.stopAll());

  const [portA1, portA2] = await Promise.all([
    manager.ensureProxy("machine:alpha", 8765),
    manager.ensureProxy("machine:alpha", 8765),
  ]);
  const portA3 = await manager.ensureProxy("machine:alpha", 8765);
  const portB = await manager.ensureProxy("machine:alpha", 5173);
  const portC = await manager.ensureProxy("machine:beta", 8765);

  assert.equal(portA1, portA2);
  assert.equal(portA1, portA3);
  assert.notEqual(portA1, portB);
  assert.notEqual(portA1, portC);
  assert.equal(manager.activeProxyCount, 3);

  const getRes = await fetch(`http://127.0.0.1:${portA1}/hello?v=1`, {
    headers: { "X-Custom": "linkshell" },
  });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get("transfer-encoding"), null);
  assert.equal(getRes.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await getRes.text(), "<h1>remote:machine:alpha:8765/hello?v=1</h1>");
  assert.ok(seenRequests[0].headers.some(([k, v]) => k.toLowerCase() === "x-custom" && v === "linkshell"));

  const binaryPayload = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  const postRes = await fetch(`http://127.0.0.1:${portA1}/upload`, {
    method: "POST",
    body: binaryPayload,
  });
  assert.equal(postRes.status, 201);
  assert.deepEqual(postRes.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  const postBytes = new Uint8Array(await postRes.arrayBuffer());
  assert.deepEqual(
    Array.from(postBytes),
    Array.from(Buffer.concat([Buffer.from("echo:", "utf8"), Buffer.from(binaryPayload)])),
  );

  const headRes = await fetch(`http://127.0.0.1:${portA1}/hello`, { method: "HEAD" });
  assert.equal(headRes.status, 200);
  assert.equal((await headRes.arrayBuffer()).byteLength, 0);

  const redirectRes = await fetch(`http://127.0.0.1:${portA1}/redirect`, { redirect: "manual" });
  assert.equal(redirectRes.status, 302);
  assert.equal(redirectRes.headers.get("location"), `http://127.0.0.1:${portA1}/dashboard?ok=1`);
});

test("RemotePortProxyManager handles unavailable window, upstream errors, timeouts, oversize bodies, and idle expiry", async (t) => {
  let mode = "unavailable";
  const manager = new RemotePortProxyManager({
    idleMs: 120,
    requestTimeoutMs: 70,
    maxRequestBodyBytes: 64,
    dispatch(payload) {
      if (mode === "unavailable") return false;
      if (mode === "error") {
        queueMicrotask(() => {
          manager.reply({ reqId: payload.reqId, error: "隧道已断开" });
        });
        return true;
      }
      // mode === "timeout": intentionally do not reply
      return true;
    },
  });
  t.after(() => manager.stopAll());

  const localPort = await manager.ensureProxy("machine:gamma", 8080);

  const unavailRes = await fetch(`http://127.0.0.1:${localPort}/`);
  assert.equal(unavailRes.status, 502);
  assert.match(await unavailRes.text(), /未就绪/);

  mode = "error";
  const errRes = await fetch(`http://127.0.0.1:${localPort}/`);
  assert.equal(errRes.status, 502);
  assert.match(await errRes.text(), /隧道已断开/);

  const tooLargeRes = await fetch(`http://127.0.0.1:${localPort}/big`, {
    method: "POST",
    body: "x".repeat(256),
  });
  assert.equal(tooLargeRes.status, 413);

  mode = "timeout";
  const timeoutRes = await fetch(`http://127.0.0.1:${localPort}/slow`);
  assert.equal(timeoutRes.status, 502);
  assert.match(await timeoutRes.text(), /超时/);

  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(manager.activeProxyCount, 0);
  await assert.rejects(() => fetch(`http://127.0.0.1:${localPort}/after-idle`));
});

test("RemotePortProxyManager refuses foreign Host headers (DNS rebinding) and WebSocket upgrades", async (t) => {
  const seen = [];
  const manager = new RemotePortProxyManager({
    dispatch(payload) {
      seen.push(payload);
      queueMicrotask(() => manager.reply({ reqId: payload.reqId, status: 200, headers: [], bodyBase64: "" }));
      return true;
    },
  });
  t.after(() => manager.stopAll());
  const port = await manager.ensureProxy("machine:alpha", 3000);

  assert.equal(isAllowedProxyHost(`127.0.0.1:${port}`, port), true);
  assert.equal(isAllowedProxyHost(`LOCALHOST:${port}`, port), true);
  assert.equal(isAllowedProxyHost(`evil.example:${port}`, port), false);
  assert.equal(isAllowedProxyHost(`127.0.0.1:${port + 1}`, port), false);
  assert.equal(isAllowedProxyHost(undefined, port), false);

  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/", headers: { host: `rebind.example:${port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 421);
  assert.equal(seen.length, 0);

  const ok = await fetch(`http://localhost:${port}/`);
  assert.equal(ok.status, 200);
  assert.equal(seen.length, 1);

  const upgradeReply = await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  assert.match(upgradeReply, /^HTTP\/1\.1 501/);
});
