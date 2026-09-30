import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost, type HostClient } from "../src/rpc/client.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A dev server in its own process and directory, as a real one would be. */
async function devServer(dir: string): Promise<{ port: number; child: ChildProcess }> {
  const source = `
    const http = require("http");
    const server = http.createServer((req, res) => {
      if (req.url === "/echo") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end("echo:" + body));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end("<html><head><title>Preview Test</title></head><body>hello</body></html>");
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ["-e", source], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  cleanup.push(() => void child.kill());
  const port = await new Promise<number>((resolve) => child.stdout!.once("data", (data) => resolve(Number(String(data).trim()))));
  return { port, child };
}

async function setup(): Promise<{ host: RunningHost; client: HostClient; dir: string }> {
  const home = mkdtempSync(join(tmpdir(), "lsh-ports-"));
  const dir = mkdtempSync(join(tmpdir(), "lsh-project-"));
  const host = await startHost({ home, version: "test", env: { PATH: process.env.PATH, HOME: home }, drivers: () => [], log: () => {} });
  const client = await connectHost(host.paths.hostSocket);
  cleanup.push(async () => {
    client.close();
    await host.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, client, dir };
}

function collect(client: HostClient, streamId: string) {
  let data = "";
  let closed = false;
  client.on("proxy.data", (params) => {
    if (params.streamId === streamId) data += Buffer.from(params.data, "base64").toString("utf8");
  });
  client.on("proxy.closed", (params) => {
    if (params.streamId === streamId) closed = true;
  });
  return { data: () => data, closed: () => closed };
}

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("port previews", () => {
  it("lists a dev server with its project and page title", async () => {
    const { client, dir } = await setup();
    const { port } = await devServer(dir);
    const { ports } = await client.call("ports.list", {});
    const found = ports.find((entry) => entry.port === port);
    expect(found).toMatchObject({ port, http: true, title: "Preview Test", process: "node" });
    expect(found?.cwd && found.cwd.endsWith(dir.split("/").pop()!)).toBe(true);
  });

  it("carries a request and its response over a stream, both ways", async () => {
    const { client, dir } = await setup();
    const { port } = await devServer(dir);
    const { streamId } = await client.call("proxy.open", { port });
    const stream = collect(client, streamId);
    const request = `POST /echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`;
    await client.call("proxy.write", { streamId, data: Buffer.from(request).toString("base64") });
    await until(() => stream.closed());
    expect(stream.data()).toMatch(/^HTTP\/1\.1 200/);
    expect(stream.data()).toContain("echo:hello");
  });

  it("refuses a port nothing listens on", async () => {
    const { client, dir } = await setup();
    const { port, child } = await devServer(dir);
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(client.call("proxy.open", { port })).rejects.toThrow(/nothing is listening/);
  });
});
