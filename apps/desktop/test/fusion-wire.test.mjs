import assert from "node:assert/strict";
import { createServer } from "node:tls";
import { test } from "node:test";
import { fusionIconFile } from "../dist/main/fusion/naming.js";
import { FUSION_CIPHER, FUSION_PSK_IDENTITY, FusionConnection, FusionFramer, connectFusion, fusionFrame, fusionPsk } from "../dist/main/fusion/wire.js";

// The Swift side (FusionWire.swift) was checked against this client on a real Mac: the TLS-PSK
// handshake completes and a v1 hello gets `bye proto` (scratch interop run, 2026-11-15).

function server(token, onConnection) {
  const psk = fusionPsk(token);
  const tls = createServer({
    ciphers: FUSION_CIPHER,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    pskCallback: (_socket, identity) => (identity === FUSION_PSK_IDENTITY ? psk : null),
  }, (socket) => onConnection(new FusionConnection(socket, true)));
  return new Promise((resolve) => tls.listen(0, "127.0.0.1", () => resolve(tls)));
}

test("frames both ways over TLS-PSK with the same token", async () => {
  const tls = await server("tok-1", (remote) => {
    remote.onMessage = (message) => {
      if (message.t === "hello") remote.send({ t: "welcome", proto: 2, session: "s-1", echo: message.displays });
    };
  });
  const reply = await new Promise((resolve, reject) => {
    const local = connectFusion("127.0.0.1", tls.address().port, "tok-1");
    local.onReady = () => local.send({ t: "hello", proto: 2, displays: [{ frame: { x: 0, y: 0, w: 10, h: 10 } }], blob: "融合".repeat(40_000) });
    local.onMessage = (message) => { local.close(); resolve(message); };
    local.onClose = (reason) => reason !== "closed" && reject(new Error(reason));
  });
  assert.equal(reply.t, "welcome");
  assert.equal(reply.session, "s-1");
  tls.close();
});

test("a wrong token never gets a message through", async () => {
  let heard = false;
  const tls = await server("right", (remote) => { remote.onMessage = () => { heard = true; }; });
  const reason = await new Promise((resolve) => {
    const local = connectFusion("127.0.0.1", tls.address().port, "wrong");
    local.onReady = () => local.send({ t: "hello" });
    local.onClose = resolve;
  });
  assert.notEqual(reason, undefined);
  assert.equal(heard, false);
  tls.close();
});

test("an unreachable port is given up as unreachable", async () => {
  const reason = await new Promise((resolve) => { connectFusion("127.0.0.1", 9, "t").onClose = resolve; });
  assert.equal(reason, "unreachable");
});

test("frames split anywhere are put back together; an oversized one is a protocol error", () => {
  const framer = new FusionFramer();
  const bytes = Buffer.concat([fusionFrame({ t: "a", n: 1 }), fusionFrame({ t: "b", s: "x".repeat(1000) })]);
  const seen = [];
  for (let i = 0; i < bytes.length; i += 7) assert.equal(framer.push(bytes.subarray(i, i + 7), (m) => seen.push(m.t)), undefined);
  assert.deepEqual(seen, ["a", "b"]);
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(16 << 20, 0);
  assert.equal(new FusionFramer().push(huge, () => {}), "protocol");
});

test("the key is HMAC-SHA256 of the label under the token, as FusionWire.psk derives it", () => {
  // HMAC-SHA256(key: "tok", msg: "linkshell-fusion-psk-v1")
  assert.equal(fusionPsk("tok").length, 32);
  assert.notDeepEqual(fusionPsk("tok"), fusionPsk("tok2"));
});

test("icon file names: a Windows app id becomes a file name, the same one FusionProtocol.iconFile writes", () => {
  // Shared vector with apps/mac/Tests/LinkShellTests/FusionProtocolTests.swift.
  assert.equal(fusionIconFile("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe"), "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}_notepad.exe");
  assert.equal(fusionIconFile("com.apple.Safari"), "com.apple.Safari");
  assert.equal(fusionIconFile("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
});
