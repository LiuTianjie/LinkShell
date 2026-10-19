// Real Windows capture -> encrypted WebRTC -> receiver; no mouse/keyboard injection.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(root, 'packages/host/package.json'));
const { RTCPeerConnection, useH264 } = require('werift');
const WebSocket = require('ws');
process.env.LINKSHELL_WINDOWS_HELPER = join(root, 'apps/windows/build/LinkShell.Screen.exe');
process.env.LINKSHELL_INPUT_DRY_RUN = '1';
const { ScreenShare } = await import(pathToFileURL(join(root, 'packages/host/dist/host/src/screen.js')));
const logs = [], share = new ScreenShare(line => { logs.push(line); console.log(line); });
const result = { frames: 0, packets: 0, keyframes: 0, bytes: 0, channels: [], input: false, fallback: false, paused: false, resumed: false };
let ws, pc, signals = Promise.resolve(), failure, fallbackRequested = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (failure) throw failure; if (Date.now() > end) throw new Error('Video check timed out: ' + JSON.stringify(result)); await delay(50); }
}
try {
  const screen = await share.start();
  ws = new WebSocket(`ws://127.0.0.1:${screen.port}/stream?token=${screen.token}&display=0&video=1&width=1280&maxFps=60&diagnostics=1`);
  const send = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  pc = new RTCPeerConnection({ codecs: { video: [useH264({ parameters: 'profile-level-id=42e02a;packetization-mode=1;level-asymmetry-allowed=1' })] }, iceServers: [] });
  pc.onIceCandidate.subscribe(candidate => { if (candidate) send({ t: 'rtc.ice', ...candidate.toJSON() }); });
  pc.onDataChannel.subscribe(channel => {
    result.channels.push(channel.label);
    channel.stateChanged.subscribe(state => {
      if (state === 'open' && channel.label === 'input') {
        channel.send(JSON.stringify({ t: 'text', s: 'WebRTC input dry run', i: 1 }));
        result.input = true;
      }
    });
  });
  pc.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => {
    result.packets++; result.bytes += packet.payload.length;
    if (packet.header.marker) result.frames++;
    const p = packet.payload, type = p[0] & 31;
    if (type === 5 || (type === 28 && (p[1] & 0x9f) === 0x85)) result.keyframes++;
  }));
  ws.on('message', (data, binary) => {
    if (binary) {
      if (data[0] === 2) { result.fallback = true; send({ t: 'ack', n: data.readUInt32BE(1) }); }
      if (!fallbackRequested) failure = new Error('Unexpected JPEG fallback');
      return;
    }
    const message = JSON.parse(data);
    if (message.error) { failure = new Error(message.error); return; }
    const rtc = message.rtc;
    if (!rtc) return;
    signals = signals.then(async () => {
      if (rtc.t === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: rtc.sdp });
        const answer = await pc.createAnswer();
        const gathering = pc.setLocalDescription(answer);
        send({ t: 'rtc.answer', sdp: answer.sdp });
        await gathering;
      } else if (rtc.t === 'ice') await pc.addIceCandidate(rtc);
    }).catch(error => { failure = error; });
  });
  await once(ws, 'open');
  await until(() => result.frames >= 60 && result.input);
  const before = result.frames;
  await delay(3000);
  result.measuredFps = Math.round((result.frames - before) / 3 * 10) / 10;
  send({ t: 'hidden' }); await delay(1500);
  const stopped = result.frames; await delay(600);
  assert.equal(result.frames, stopped); result.paused = true;
  send({ t: 'shown' }); await until(() => result.frames > stopped + 5); result.resumed = true;
  fallbackRequested = true; send({ t: 'rtc.failed', reason: 'verification fallback' });
  await until(() => result.fallback);
  assert.ok(result.keyframes > 0);
  assert.deepEqual(result.channels.sort(), ['cursor', 'input', 'pointer', 'shape']);
  await until(() => logs.some(line => line.includes('WebRTC input dry run')));
  writeFileSync(join(root, 'artifacts/windows-video-verified.json'), JSON.stringify({ ...result, logs }, null, 2));
  console.log(JSON.stringify(result));
} finally {
  ws?.close();
  if (ws && ws.readyState !== WebSocket.CLOSED) await once(ws, 'close');
  await pc?.close(); share.stop();
}
