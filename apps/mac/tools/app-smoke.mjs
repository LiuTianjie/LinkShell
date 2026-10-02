#!/usr/bin/env node
// Proves the built LinkShell.app runs with no window, started by the system: opens it on a
// socket, prints its `status`, asks for an offer and says what the offer holds, then closes.
// Exits 1 when the app doesn't answer, the offer isn't one a viewer can take (a video section
// that sends H.264 first, and a section for the data channels), or the app outlives its socket.
//
//   node tools/app-smoke.mjs [--fps 30] [--maxWidth 1920] [--codec h264|hevc] [--clock] [--rtc-log] [--no-playout-delay]

import { launch } from "./app.mjs";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const flags = ["--clock", "--rtc-log", "--no-playout-delay"].filter((flag) => args.includes(flag));
const PLAYOUT_DELAY = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay";

/** The parts of an SDP that decide what is sent: one entry a media section. */
export function summarize(sdp) {
  const sections = sdp.split(/\r?\nm=/).slice(1).map((text) => `m=${text}`.split(/\r?\n/));
  return sections.map((lines) => {
    const [kind, , protocol, ...formats] = lines[0].slice(2).split(" ");
    const fmtp = new Map(lines.filter((line) => line.startsWith("a=fmtp:")).map((line) => [line.slice(7, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]));
    return {
      kind,
      protocol,
      mid: lines.find((line) => line.startsWith("a=mid:"))?.slice(6),
      direction: lines.find((line) => /^a=(sendonly|recvonly|sendrecv|inactive)$/.test(line))?.slice(2),
      codecs: lines
        .filter((line) => line.startsWith("a=rtpmap:"))
        .map((line) => {
          const [payload, name] = line.slice(9).split(" ");
          return `${payload} ${name}${fmtp.has(payload) ? ` (${fmtp.get(payload)})` : ""}`;
        }),
      extensions: lines.filter((line) => line.startsWith("a=extmap:")).map((line) => line.slice(9)),
      sctp: lines.find((line) => line.startsWith("a=sctp-port:"))?.slice(2),
      formats: kind === "application" ? formats.join(" ") : undefined,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await launch(flags);
  app.on("log", (message) => console.log(`log    ${message.message}`));
  let refused;
  app.on("rtc.error", (message) => (refused = message.message));
  app.on("rtc.state", (message) => console.log(`state  ice ${message.ice}, connection ${message.connection}`));
  let candidates = 0;
  app.on("rtc.ice", () => (candidates += 1));

  let failed = false;
  try {
    const status = await app.next("status", 5000);
    console.log(`status ${JSON.stringify(status)}   (pid ${app.pid})`);
    if (!status.recording) throw new Error("recording is false: Screen Recording is not allowed for this LinkShell.app — not asking again");

    app.send({
      t: "rtc.open",
      v: "smoke",
      iceServers: [],
      ...(value("--fps") ? { fps: Number(value("--fps")) } : {}),
      ...(value("--maxWidth") ? { maxWidth: Number(value("--maxWidth")) } : {}),
      ...(value("--codec") ? { codec: value("--codec") } : {}),
    });
    const offer = await app.next("rtc.offer", 10_000);
    const sections = summarize(offer.sdp);
    for (const section of sections) {
      console.log(`\nm=${section.kind} (${section.protocol}) mid ${section.mid}${section.direction ? `, ${section.direction}` : ""}`);
      if (section.kind === "application") console.log(`  data channels: ${section.formats}, ${section.sctp}`);
      for (const codec of section.codecs) console.log(`  codec      ${codec}`);
      for (const extension of section.extensions) console.log(`  extension  ${extension}`);
      if (section.kind === "video") console.log(`  playout-delay extension offered: ${section.extensions.some((extension) => extension.includes(PLAYOUT_DELAY)) ? "yes" : "NO"}`);
    }
    const video = sections.find((section) => section.kind === "video");
    const wanted = value("--codec") === "hevc" ? /^\d+ H26[45]\// : /^\d+ H264\//;
    if (video?.direction !== "sendonly" || !wanted.test(video.codecs[0] ?? "")) throw new Error(`the offer's video is not H.264, sent one way: ${video ? `${video.direction}, first codec ${video.codecs[0]}` : "no video section"}`);
    if (!sections.some((section) => section.kind === "application")) throw new Error("the offer has no section for the data channels");
    // A moment for the capture to say it started (or why it didn't) and for candidates to come.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`\nice candidates gathered: ${candidates}`);
    if (refused) throw new Error(refused);
    app.send({ t: "rtc.close", v: "smoke" });
  } catch (error) {
    failed = true;
    console.error(`FAILED ${refused ?? error.message}`);
  }
  const went = await app.close();
  console.log(went ? "closed: the app ended with the socket" : "closed: THE APP DID NOT END WITH THE SOCKET (killed)");
  console.log(failed || !went ? "\n[app-smoke] FAILED" : "\n[app-smoke] ok");
  process.exit(failed || !went ? 1 : 0);
}
