import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionClipboard, MAX_CLIPBOARD_BYTES } from "../dist/main/fusion/clipboard.js";

function board(initial = {}) {
  const state = { text: "", image: undefined, concealed: false, ...initial };
  const sent = [];
  const png = () => state.image && Buffer.concat([Buffer.from("PNG"), state.image]);
  const port = {
    read: async () => ({
      text: state.text, concealed: state.concealed,
      types: [state.text ? "text/plain" : "", state.image ? "image/png" : ""].join(","),
      png: async () => png(),
    }),
    write: async (clip) => { state.text = clip.text ?? ""; state.image = clip.png ? clip.png.subarray(3) : undefined; },
  };
  return { state, sent, clipboard: new FusionClipboard(port, (m) => sent.push(m)) };
}

test("what is copied goes once, on focus, and again only when it changes", async () => {
  const { state, sent, clipboard } = board({ text: "one" });
  await clipboard.tick();
  assert.equal(sent.length, 0, "nothing before the user has been in a window");
  await clipboard.focused();
  await clipboard.focused();
  await clipboard.tick();
  assert.deepEqual(sent, [{ t: "clip", text: "one" }]);
  state.text = "two";
  await clipboard.tick();
  assert.deepEqual(sent[1], { t: "clip", text: "two" });
});

test("a picture goes as PNG; a second picture with the same formats is seen at the next focus", async () => {
  const { state, sent, clipboard } = board({ image: Buffer.from([1, 2, 3, 4]) });
  await clipboard.focused();
  assert.equal(sent[0].png, Buffer.concat([Buffer.from("PNG"), Buffer.from([1, 2, 3, 4])]).toString("base64"));
  state.image = Buffer.from([9, 9, 9, 9]);
  await clipboard.tick();
  assert.equal(sent.length, 1, "the cheap look cannot tell two pictures apart");
  await clipboard.focused();
  assert.equal(sent.length, 2);
});

test("what the remote sent is written and not sent back", async () => {
  const { state, sent, clipboard } = board();
  await clipboard.received({ t: "clip", text: "early" });
  assert.equal(state.text, "", "not before the first focus");
  await clipboard.focused();
  await clipboard.received({ t: "clip", text: "from remote", png: Buffer.from("PNGabcd").toString("base64") });
  assert.equal(state.text, "from remote");
  assert.deepEqual([...state.image], [...Buffer.from("abcd")]);
  await clipboard.tick();
  await clipboard.focused();
  assert.equal(sent.length, 0);
});

test("concealed and oversized clipboards stay here", async () => {
  const secret = board({ text: "hunter2", concealed: true });
  await secret.clipboard.focused();
  assert.equal(secret.sent.length, 0);
  const big = board({ text: "caption", image: Buffer.alloc(MAX_CLIPBOARD_BYTES) });
  await big.clipboard.focused();
  assert.deepEqual(big.sent, [{ t: "clip", text: "caption" }], "the picture is left out, the text still goes");
  await big.clipboard.received({ t: "clip", png: Buffer.alloc(MAX_CLIPBOARD_BYTES + 1).toString("base64") });
  assert.equal(big.state.text, "caption");
});
