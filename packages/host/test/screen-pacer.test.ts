import { describe, expect, it } from "vitest";
import { Pacer } from "../src/screen-pacer.js";

/** A path that shows each frame `delay` ms after it was sent; frames that weren't sent are never shown. */
function play(pacer: Pacer, options: { from: number; to: number; fps: number; delay: (at: number) => number }) {
  const sent: { seq: number; at: number; key: boolean }[] = [];
  const dropped: number[] = [];
  const pending: { seq: number; at: number }[] = [];
  const step = 1000 / options.fps;
  let frame = 0;
  for (let now = options.from; now < options.to; now += step, frame++) {
    while (pending.length && pending[0]!.at <= now) pacer.ack(pending.shift()!.seq, now);
    const key = frame % options.fps === 0;
    const seq = pacer.next(key, now);
    if (seq === undefined) dropped.push(now);
    else {
      sent.push({ seq, at: now, key });
      // In order, as the pipes deliver: never shown before the frame ahead of it.
      const due = Math.max(now + options.delay(now), pending.at(-1)?.at ?? 0);
      pending.push({ seq, at: due });
    }
  }
  return { sent, dropped };
}

describe("keeping a viewer close to live", () => {
  it("sends every frame while the viewer keeps up", () => {
    const pacer = new Pacer(0);
    const { sent, dropped } = play(pacer, { from: 0, to: 10_000, fps: 20, delay: () => 120 });
    expect(dropped).toEqual([]);
    expect(sent.length).toBe(200);
    expect(pacer.advice(10_000, false, true)).toBeUndefined();
  });

  it("stops adding to the queue when the viewer falls behind, and comes back in at a keyframe", () => {
    const pacer = new Pacer(0);
    // Fine for two seconds, then the network stalls: frames take 3 s to show for a while.
    const { sent, dropped } = play(pacer, { from: 0, to: 12_000, fps: 20, delay: (at) => (at >= 2000 && at < 4000 ? 3000 : 100) });
    expect(dropped.length).toBeGreaterThan(20);
    // Dropping starts within about half a second of the stall, not after seconds of queue.
    expect(dropped[0]!).toBeLessThan(2000 + 800);
    // After a gap, the first frame sent is a keyframe: the decoder can pick up from it.
    for (let i = 1; i < sent.length; i++) {
      if (sent[i]!.at - sent[i - 1]!.at > 60) expect(sent[i]!.key).toBe(true);
    }
    // And it does come back.
    expect(sent.at(-1)!.at).toBeGreaterThan(11_000);
    expect(pacer.dropping).toBe(false);
  });

  it("asks for a lighter picture when the path keeps falling behind, and a better one only after a calm stretch", () => {
    const pacer = new Pacer(0);
    let now = 0;
    const advice: string[] = [];
    // A path that can't carry this picture: every frame takes two seconds.
    let last = 0;
    for (let frame = 0; now < 8000; now += 50, frame++) {
      last = pacer.next(frame % 20 === 0, now) ?? last;
      const said = pacer.advice(now, false, true);
      if (said) {
        advice.push(said);
        break;
      }
    }
    expect(advice).toEqual(["down"]);
    expect(now).toBeLessThan(4000);

    // The lighter picture holds (what was on its way arrives a moment later): nothing more is asked
    // for half a minute, then a better one is tried.
    pacer.restarted(now);
    const start = now;
    pacer.ack(last, now + 1500);
    let raised: number | undefined;
    const pending: { seq: number; at: number }[] = [];
    for (let frame = 0; now < start + 45_000 && raised === undefined; now += 100, frame++) {
      while (pending.length && pending[0]!.at <= now) pacer.ack(pending.shift()!.seq, now);
      const seq = pacer.next(frame % 10 === 0, now);
      if (seq !== undefined) pending.push({ seq, at: now + 100 });
      const said = pacer.advice(now, true, true);
      if (said === "up") raised = now;
      else expect(said).toBeUndefined();
    }
    expect(raised).toBeGreaterThan(start + 29_000);
  });

  it("doesn't pace a viewer that never says what it has shown", () => {
    const pacer = new Pacer(0);
    let sent = 0;
    for (let now = 0, frame = 0; now < 20_000; now += 50, frame++) if (pacer.next(frame % 20 === 0, now) !== undefined) sent++;
    // It holds back at first, as for any viewer that is behind; once it is plain nothing will be said, everything goes.
    expect(sent).toBeGreaterThan(290);
  });
});

describe("after a change of picture", () => {
  it("what was already on its way gets time to arrive before the picture is made lighter again", () => {
    const pacer = new Pacer(0);
    let now = 0;
    let level = 0;
    const changes: number[] = [];
    // A path that carries nothing for six seconds, then everything.
    const pending: number[] = [];
    for (let frame = 0; now < 30_000; now += 50, frame++) {
      if (now >= 6000) while (pending.length) pacer.ack(pending.shift()!, now);
      const seq = pacer.next(frame % 20 === 0, now);
      if (seq !== undefined) pending.push(seq);
      const said = pacer.advice(now, level > 0, level < 4);
      if (said) {
        level += said === "down" ? 1 : -1;
        changes.push(now);
        pacer.restarted(now);
      }
    }
    // One step down for one bad stretch, a second only because it lasted through the settling time: not a fall to the bottom.
    expect(changes.length).toBeLessThanOrEqual(2);
    expect(level).toBeLessThanOrEqual(2);
  });
});

describe("a viewer that drops what it had when the picture changes", () => {
  it("is sent the new stream at once: frames of the old one that were never shown are not waited for", () => {
    const pacer = new Pacer(0);
    let now = 0;
    // Twenty frames go out; the viewer shows five, then the picture changes and it throws the rest away.
    for (let frame = 0; frame < 20; frame++, now += 50) pacer.next(frame === 0, now);
    pacer.ack(5, now);
    now += 2000;
    expect(pacer.next(false, now)).toBeUndefined();
    pacer.restarted(now);
    // The new stream's keyframe goes, and what follows it.
    const key = pacer.next(true, now);
    expect(key).toBeDefined();
    expect(pacer.next(false, now + 50)).toBeDefined();
    pacer.ack(key!, now + 120);
    expect(pacer.dropping).toBe(false);
  });

  it("is sent a keyframe now and then while it says nothing, so that it can always come back", () => {
    const pacer = new Pacer(0);
    const pending: number[] = [];
    let now = 0;
    for (let frame = 0; now < 3000; frame++, now += 50) {
      const seq = pacer.next(frame % 20 === 0, now);
      if (seq !== undefined && now < 1000) pacer.ack(seq, now + 10);
      else if (seq !== undefined) pending.push(seq);
    }
    expect(pacer.dropping).toBe(true);
    // Silence: only the odd keyframe goes.
    const sent: number[] = [];
    for (let frame = 0; now < 40_000; frame++, now += 50) {
      const seq = pacer.next(frame % 20 === 0, now);
      if (seq !== undefined) sent.push(seq);
    }
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBeLessThanOrEqual(6);
    // It answers for the last of them: back to every frame.
    pacer.ack(sent.at(-1)!, now);
    let after = 0;
    for (let frame = 0; frame < 40; frame++, now += 50) {
      const seq = pacer.next(frame % 20 === 0, now);
      if (seq === undefined) continue;
      after++;
      pacer.ack(seq, now + 20);
    }
    expect(after).toBeGreaterThan(18);
  });
});
