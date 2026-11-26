/** WebRTC peer connection, media presentation, and DataChannel setup for the viewer. */
export const WEBRTC_SCRIPT = String.raw`
// ---- The picture as a video track -----------------------------------------

// The computer's app offers the track, and channels beside it for the hands and the pointer; this end only
// answers. The socket carries what the two need to find each other — and the picture itself once the host
// says so (rtc "off"): there is no app to send a track, or this end said the track didn't get across.
// rtc is the connection while there is one; live, that the picture on show is the track's. A socket that
// has given the track up does not try again.
let rtc = null, live = false, tried = false, gaveUp = false, blocked = false, patience = 0, relayRequested = false;
// For trying the way back out: ?failAfter=5 gives the track up 5 s after it was offered.
const failAfter = Number(query.get("failAfter")) || 0;
// How long a path may take to be found. A phone on a cellular network can take well over 8 s
// to gather and check its candidates through the gateway; once given up there is no retry.
const patienceSeconds = Math.min(60, Math.max(5, Number(query.get("patience")) || 25));

/** What ICE gathered and tried, for the reason a track was given up. */
async function iceSummary(pc) {
  try {
    const report = await pc.getStats();
    const local = {}, remote = {}, pairs = {};
    let selected = "";
    report.forEach((entry) => {
      if (entry.type === "local-candidate") local[entry.candidateType] = (local[entry.candidateType] || 0) + 1;
      else if (entry.type === "remote-candidate") remote[entry.candidateType] = (remote[entry.candidateType] || 0) + 1;
      else if (entry.type === "candidate-pair") {
        pairs[entry.state] = (pairs[entry.state] || 0) + 1;
        if (entry.nominated && entry.state === "succeeded") selected = "nominated";
      }
    });
    const list = (counts) => Object.entries(counts).map(([kind, n]) => kind + "×" + n).join(",") || "none";
    return "local " + list(local) + "; remote " + list(remote) + "; pairs " + list(pairs) + (selected ? "; " + selected : "")
      + "; ice " + pc.iceConnectionState + "/" + pc.iceGatheringState;
  } catch {
    return "no statistics";
  }
}

function signal(message) {
  if (message.t === "off") return fallBack();
  if (gaveUp) return;
  if (message.t === "config") return connect(message.iceServers || []);
  const mine = rtc;
  if (!mine) return;
  if (message.t === "offer") {
    tried = true;
    clearTimeout(patience);
    patience = setTimeout(() => connectionPatience(mine), patienceSeconds * 1000);
    if (failAfter) setTimeout(() => { if (rtc === mine) giveUp("asked to (failAfter)"); }, failAfter * 1000);
    // The answer is the browser's own, as it made it: the sender's playout-delay header has to survive in it,
    // unless the viewer chose even pacing, which is not agreeing to that header at all.
    mine.described = mine.pc.setRemoteDescription({ type: "offer", sdp: pacing === "smooth" ? withoutPlayoutDelay(message.sdp) : message.sdp })
      .then(() => {
        // Strip FlexFEC-03 on receiver transceivers so repair packets do not steal video bitrate on clean/LAN links.
        if (typeof mine.pc.getTransceivers === "function" && typeof RTCRtpReceiver !== "undefined" && typeof RTCRtpReceiver.getCapabilities === "function") {
          const caps = RTCRtpReceiver.getCapabilities("video");
          const preferred = caps && Array.isArray(caps.codecs) ? caps.codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/flexfec-03") : [];
          if (preferred.length > 0) {
            for (const transceiver of mine.pc.getTransceivers()) {
              if (transceiver.receiver && transceiver.receiver.track && transceiver.receiver.track.kind === "video" && typeof transceiver.setCodecPreferences === "function") {
                try { transceiver.setCodecPreferences(preferred); } catch {}
              }
            }
          }
        }
        return mine.pc.createAnswer();
      })
      .then((answer) => mine.pc.setLocalDescription(answer))
      .then(() => { if (rtc === mine) send({ t: "rtc.answer", sdp: mine.pc.localDescription.sdp }); });
    mine.described.catch((error) => { if (rtc === mine) giveUp("the offer could not be answered: " + error.message); });
  } else if (message.t === "ice") {
    // A candidate that comes before the offer is in place waits for it.
    mine.described.then(() => mine.pc.addIceCandidate({ candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex })).catch(() => {});
  }
}

function connect(iceServers) {
  drop();
  let pc;
  // ?ice=relay: only relayed paths, to try the TURN server out where a direct one would be found.
  try { pc = new RTCPeerConnection({ iceServers, ...(query.get("ice") === "relay" ? { iceTransportPolicy: "relay" } : {}) }); }
  catch (error) { return giveUp("the receiver could not start: " + error.message); }
  const mine = (rtc = { pc, channels: {}, described: Promise.resolve(), up: false, away: 0 });
  pc.onicecandidate = ({ candidate }) => {
    // The empty one only says there are no more.
    if (candidate && candidate.candidate) send({ t: "rtc.ice", candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null });
  };
  pc.ontrack = ({ receiver, track, streams }) => {
    // No waiting beyond what decoding takes. Safari has neither knob: there the sender's playout-delay header does it.
    // Even pacing keeps the browser's adaptive buffer.
    if (pacing !== "smooth") {
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
      if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0;
    }
    video.srcObject = streams[0] || new MediaStream([track]);
    // The <video> starts either way: it is what shows the picture where this page cannot present
    // the frames itself, and what it falls back to if the presenter stops. Taking the frames is
    // tried alongside it, and the <video> is hidden only once frames are actually coming.
    play();
    presentTrack(track).then(
      (presenting) => {
        if (!presenting || rtc !== mine) return stopPresenting();
        video.classList.add("gone");
        gpu.classList.remove("gone");
      },
      () => stopPresenting(),
    );
  };
  pc.ondatachannel = ({ channel }) => {
    mine.channels[channel.label] = channel;
    if (channel.label === "cursor" || channel.label === "shape") channel.onmessage = (event) => { if (rtc === mine) told(JSON.parse(event.data)); };
    else if (channel.label === "audio") {
      channel.binaryType = "arraybuffer";
      channel.onmessage = (event) => { if (rtc === mine && typeof handleAudioMessage === "function") handleAudioMessage(event.data); };
    }
  };
  pc.oniceconnectionstatechange = pc.onconnectionstatechange = () => { if (rtc === mine) watch(mine); };
}

function watch(mine) {
  // The whole connection's state where the browser has one: a path found is not yet a connection made.
  const state = mine.pc.connectionState || mine.pc.iceConnectionState;
  if (state === "failed" || mine.pc.iceConnectionState === "failed") return giveUp(mine.up ? "the connection failed" : "no path between the two (ICE failed)");
  if (state === "disconnected") {
    showProgress("recovering");
    // A path that drops for a moment comes back by itself; one gone for longer is given up.
    if (mine.up && !mine.away) mine.away = setTimeout(() => away(mine, performance.now()), 4000);
  } else if (state === "connected" || state === "completed") {
    if (loading.phase !== "ready") showProgress("receiving");
    clearTimeout(mine.away);
    mine.away = 0;
    // Clear any offer/ICE-restart patience timer even when reconnecting an already-up peer.
    clearTimeout(patience);
    patience = 0;
    if (mine.up) return;
    mine.up = true;
    if (loading.phase !== "ready") patience = setTimeout(frameless, 4000);
  }
}

function away(mine, since) {
  if (rtc !== mine) return;
  // A page that was put aside (another app, another tab) could not hear the path come back: once it is
  // looked at again it is given the time again.
  const now = performance.now();
  if (!session.active() || now - since > 6000) mine.away = setTimeout(() => away(mine, now), 4000);
  else giveUp("disconnected for more than 4 s");
}

function connectionPatience(mine) {
  if (rtc !== mine) return;
  const state = mine.pc.connectionState || mine.pc.iceConnectionState;
  if (state === "connected" || state === "completed") {
    patience = 0;
    return;
  }
  if (!session.active()) patience = setTimeout(() => connectionPatience(mine), patienceSeconds * 1000);
  else giveUp("not connected within " + patienceSeconds + " s of the offer");
}

function frameless() {
  // A page nobody is looking at is shown nothing, and one waiting for a tap has not begun: neither is the path's doing.
  if (!session.active() || blocked) patience = setTimeout(frameless, 4000);
  else giveUp("connected, but no frame within 4 s");
}

/** The track is not getting across: the host is asked for the picture down the socket instead. */
function giveUp(reason) {
  if (gaveUp) return;
  gaveUp = true;
  showProgress("recovering");
  const pc = rtc && rtc.pc;
  const told = (detail) => {
    drop();
    // The host's log says why, whichever way the picture goes next; with no connection there is nothing to say.
    if (detail) send({ t: "rtc.diagnosis", reason, ice: detail });
    if (!requestRelay()) send({ t: "rtc.failed", reason: detail ? reason + " (" + detail + ")" : reason });
  };
  if (pc) iceSummary(pc).then(told, () => told(""));
  else told("");
}

function requestRelay() {
  if (!relayFallback) return false;
  if (!relayRequested) {
    relayRequested = true;
    tellApp({ type: "screenFallback" });
    showProgress("recovering");
  }
  return true;
}

function drop() {
  clearTimeout(patience);
  patience = 0;
  stopPresenting();
  if (typeof resetAudioPlayback === "function") resetAudioPlayback();
  if (!rtc) return;
  clearTimeout(rtc.away);
  const pc = rtc.pc;
  rtc = null;
  pc.ontrack = pc.ondatachannel = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
  pc.close();
}

/** The picture comes down the socket from here on. What the track last showed stays up until its first frame. */
function fallBack() {
  gaveUp = true;
  drop();
  if (requestRelay()) return;
  showProgress("recovering");
  blocked = false;
  if (!windowsHost && !("VideoDecoder" in window)) return unseeable();
  if (tried) hint(live ? "直连断开了：已改用兼容方式传画面，延迟会高一些" : "没能和电脑直连：已改用兼容方式传画面，延迟会高一些", 5000);
}

if (!nativePicture && !wantVideo) requestRelay();

function play() {
  const started = video.play();
  if (!started) return;
  started.then(() => {
    if (!blocked) return;
    blocked = false;
    showProgress("receiving");
  }, (error) => {
    // A new stream replacing the one being started rejects the first call too; that is not a refusal.
    if (error.name === "AbortError" || !rtc) return;
    blocked = true;
    if (!sessionError && !sessionPhase) loading.set("blocked", "浏览器需要你的确认，轻点屏幕即可开始观看。");
  });
}
// What a browser takes as someone's say-so to start a video.
if (wantVideo) for (const name of ["pointerup", "touchend", "click", "keydown"]) addEventListener(name, () => { if (blocked && rtc) play(); }, true);

/** The track's picture has a size: at its first frame, and whenever the sender changes its resolution. */
function sized() {
  if (!rtc || !video.videoWidth) return;
  // While this page presents the frames itself, the size that counts is the frame's own: the
  // <video> is kept running as the fallback but is not what is on screen.
  if (presenter) {
    if (presenter.shown) clearTimeout(patience);
    if (!live) show(true);
    return;
  }
  content.w = video.videoWidth;
  content.h = video.videoHeight;
  if (live) return layout();
  show(true);
}
video.addEventListener("resize", sized);
video.addEventListener("loadedmetadata", sized);
// Metadata and a connected socket do not mean a frame is visible yet.
function videoShown() {
  if (!rtc || blocked || video.readyState < 2 || presenter) return;
  clearTimeout(patience);
  sized();
  say("");
}
if ("requestVideoFrameCallback" in video) {
  const nextFrame = () => {
    if (loading.phase !== "ready") videoShown();
    video.requestVideoFrameCallback(nextFrame);
  };
  video.requestVideoFrameCallback(nextFrame);
} else {
  video.addEventListener("playing", videoShown);
  video.addEventListener("timeupdate", videoShown);
}

// ---- Presenting the track's frames this page's own way --------------------

// The browser's own <video> is decoded in hardware, but what happens after the decoder is the
// compositor's: it holds each frame for its own schedule, and a box that does not land on whole
// device pixels is resampled. Where the pieces exist (Chromium: MediaStreamTrackProcessor and
// WebGPU's importExternalTexture) the frames are taken straight from the decoder instead, the
// newest one is kept and the older ones dropped, and it is drawn at the moment the display asks
// for it. Nothing is copied through JS and no pixels leave the GPU. Everywhere else (Safari,
// Firefox) the <video> stays exactly as it was.
const canPresent = "MediaStreamTrackProcessor" in window && "gpu" in navigator && !nativePicture && !query.has("noGpu");
let presenter = null;

async function presentTrack(track) {
  if (!canPresent) return false;
  let adapter, device;
  try {
    adapter = await navigator.gpu.requestAdapter();
    device = adapter && (await adapter.requestDevice());
  } catch { device = null; }
  if (!device) return false;
  const context = gpu.getContext("webgpu");
  if (!context) return false;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  // One triangle pair, the frame sampled onto it. An external texture is bound per frame: its
  // group cannot outlive the frame it was made from, so it is made in the draw and dropped after.
  const shader = device.createShaderModule({ code: [
    "@group(0) @binding(0) var sampler0: sampler;",
    "@group(0) @binding(1) var frame: texture_external;",
    "struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }",
    "@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {",
    "  var p = array(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(1,1));",
    "  var out: Out;",
    "  out.pos = vec4f(p[i], 0, 1);",
    "  out.uv = vec2f((p[i].x + 1) * 0.5, (1 - p[i].y) * 0.5);",
    "  return out;",
    "}",
    "@fragment fn fs(in: Out) -> @location(0) vec4f {",
    "  return textureSampleBaseClampToEdge(frame, sampler0, in.uv);",
    "}",
  ].join("\n") });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-strip" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  // The mailbox: one frame, the newest. A frame that arrives before the display asked for the
  // last one replaces it — the old one is closed, not queued, so the picture never shows the past.
  const mine = { stopped: false, latest: null, drawing: false, shown: 0, dropped: 0, w: 0, h: 0 };
  presenter = mine;

  const draw = () => {
    if (mine.stopped || !mine.latest) return;
    const frame = mine.latest;
    mine.latest = null;
    if (!session.active()) { frame.close(); return; }
    try {
      // The canvas carries the frame's own pixels; the layout gives it its place on the page.
      if (gpu.width !== frame.displayWidth || gpu.height !== frame.displayHeight) {
        gpu.width = frame.displayWidth;
        gpu.height = frame.displayHeight;
      }
      const external = device.importExternalTexture({ source: frame });
      const pass = device.createCommandEncoder();
      const draws = pass.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      draws.setPipeline(pipeline);
      draws.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: external }] }));
      draws.draw(4);
      draws.end();
      device.queue.submit([pass.finish()]);
      mine.shown += 1;
      say("");
      if (mine.w !== frame.displayWidth || mine.h !== frame.displayHeight) {
        mine.w = frame.displayWidth;
        mine.h = frame.displayHeight;
        content.w = frame.displayWidth;
        content.h = frame.displayHeight;
        // Frames of its own are the picture arriving: the wait for one ends here, whether or not
        // the <video> beside it was allowed to start playing.
        clearTimeout(patience);
        blocked = false;
        if (!live) show(true);
        else layout();
      }
    } catch (error) {
      frame.close();
      return stopPresenting("the frame could not be drawn: " + error.message);
    }
    frame.close();
  };
  // One draw in flight at a time, on the display's own beat: more submissions than the screen can
  // show would only queue work on the GPU, which is the delay this path exists to remove.
  const beat = () => {
    if (mine.stopped) return;
    mine.drawing = false;
    draw();
  };
  const wake = () => {
    if (mine.drawing || mine.stopped) return;
    mine.drawing = true;
    requestAnimationFrame(beat);
  };

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || mine.stopped) {
          if (value) value.close();
          break;
        }
        if (!session.active()) { value.close(); continue; }
        if (mine.latest) {
          mine.latest.close();
          mine.dropped += 1;
        }
        mine.latest = value;
        wake();
      }
    } catch (error) {
      if (!mine.stopped) stopPresenting("the frames stopped arriving: " + error.message);
    }
  })();
  // A track that ends (a reconnect, the sender stopping) takes its presenter with it.
  track.addEventListener("ended", () => { if (presenter === mine) stopPresenting("the track ended"); }, { once: true });
  return true;
}

/** Back to the browser's own <video>, keeping the track that is already running. */
function stopPresenting(reason) {
  const mine = presenter;
  if (!mine || mine.stopped) return;
  mine.stopped = true;
  presenter = null;
  if (mine.latest) mine.latest.close();
  mine.latest = null;
  gpu.classList.add("gone");
  if (reason) send({ t: "rtc.diagnosis", reason: "gpu presentation stopped: " + reason, ice: "" });
  // The track is still there: the <video> shows it from here on.
  if (live && rtc) {
    video.classList.remove("gone");
    if (video.srcObject) play();
    layout();
  }
}

/** Which of the three the picture is on: this page's own presenter or the <video> while a track runs, the canvas otherwise. */
function show(track) {
  live = track;
  const own = track && !!presenter;
  video.classList.toggle("gone", !track || own);
  gpu.classList.toggle("gone", !own);
  canvas.classList.toggle("gone", track);
  if (!track) {
    stopPresenting();
    video.srcObject = null;
    content.w = content.h = 0;
    pointer.classList.remove("on");
  }
  refresh();
}
`;
