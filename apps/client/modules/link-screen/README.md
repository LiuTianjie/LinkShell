# Native iOS screen receiver

This local Expo module owns the WebRTC receiver, decoded-frame mailbox, Metal
presentation and screen gestures. It shares the installed JitsiWebRTC framework
with `react-native-webrtc`. The existing host forwarder carries authenticated
signalling; the media track remains DTLS-SRTP peer to peer.

iOS starts with this receiver automatically and requests a **120 fps ceiling**.
The source display, receiver display, thermal state, Low Power Mode and transport
adaptation bound the actual frame rate. No playback-mode or frame-rate switch is
required. If the native receiver cannot start or loses its connection, the app
tries the standard WebRTC viewer, then the socket viewer through the encrypted
RPC/relay channel. The last step bypasses the direct data channel for this screen
only. A retry or a new screen visit starts with the native receiver again.
Android continues to use the standard viewer and its existing fallback.

This module ships in the normal LinkShell app (`com.bd.linkshell`) through the
regular TestFlight/App release workflow. There is no separate preview route or
acceptance app. A new native binary is required; a Metro reload cannot add it.
Diagnostics report sender and decoder output separately; neither is a physical
display-rate result.

## Pipeline

- The host accepts `maxFps=30|60|120` as a receiver ceiling, leaving adaptation
  enabled. Existing receivers remain at the existing 60/30 defaults. The Mac
  bounds its rate by the source display and uses 120/60/30 when both sides allow it.
- H.264 decodes through WebRTC's VideoToolbox decoder to `RTCCVPixelBuffer`.
  Frames and touch gestures never cross JS. No camera or microphone track is made.
- A single-slot decoded-frame mailbox replaces obsolete pending output. Encoded
  reference frames remain with WebRTC's dependency-aware receiver.
- Metal maps NV12 planes through `CVMetalTextureCache`; one pass renders the
  picture and cursor. At most one GPU submission is in flight. A missed rendering
  deadline retains the newest candidate for the next display opportunity.
- iOS 17+ uses `CAMetalDisplayLink` with `preferredFrameLatency=1`; older supported
  iOS uses `CADisplayLink`. Display capabilities, Low Power Mode and thermal state
  bound the requested rate. No claim of physical scanout control is made.
- Closing the view or backgrounding tears down the socket, peer, track and display
  link. Reconnection starts a new session and releases held pointer state.

## Measurement overhead

Diagnostics are **off by default**. This path uses the stock decoder directly:
there is no timing wrapper, per-frame presentation timing handler, stats polling,
trace allocation, diagnostic JS event or diagnostic network traffic. The GPU
completion handler and deadline estimate are part of normal presentation control.

The **诊断信息** control starts an instrumented session. It samples RTP timestamps
at approximately 1 in 31 frames, collects locally in bounded buffers, and reports
once every five seconds. Only sampled frames acquire measurement locks and record
decode/presentation timestamps. The displayed FPS is decoder output, not a claim
about distinct frames physically shown. Inter-sample gaps are never reported as
display jitter. Full tracing is a separate internal diagnostic mode, not enabled
by the viewer's sampling control.

Diagnostic percentiles are estimates and include their sample count. They measure
decoder and decode-to-presentation work, **not end-to-end capture-to-photon
latency**. Validation must compare instrumentation off/on using the same external
method and workload. Report the measured overhead and uncertainty; do not claim
zero observer effect. Never enable full tracing for a headline latency benchmark.

## Validation

```sh
swift test --package-path apps/client/modules/link-screen --scratch-path /tmp/linkshell-screen-tests
pnpm --filter @linkshell/mac test
pnpm --filter @linkshell/host test
pnpm typecheck
pnpm lint
pnpm build
```

The Swift package checks scheduling primitives without Expo, a screen or WebRTC.
The playback-state tests cover automatic fallback order and stale callbacks;
viewer tests exercise standard WebRTC failure and the relay request. The stream
integration test checks that a forced RPC stream coexists with direct streams.
On 2026-10-10, the receiver built for arm64 iPhone with Xcode 27.1 and passed
code-signature verification. Build evidence does not establish screen performance
or interaction correctness.

Known issue: the user reports a short periodic stutter roughly once per second
or faster in both native and web receivers. A native diagnostic snapshot showed
120 encoded / 116 decoded fps and decode-to-presentation p95 of 30.6 ms. The cause
has not been established or fixed; average throughput is not a frame-pacing pass.
Further diagnosis is deferred at the user's request.

Device checks use the regular release app:

1. Enter the screen and verify automatic native playback with diagnostics off.
   A 120 Hz source and receiver allow the highest ceiling; diagnostics can briefly
   distinguish actual encoded/decoded FPS from the request.
2. Check pointer/drag, scroll, keyboard, zoom, rotation, screen selection and
   reconnect/backgrounding. Run for 30 minutes to assess heat and sustained cadence.
3. Test networks where direct video is unavailable and confirm the automatic
   standard-video and relay fallbacks, with usable input after the transition.

Diagnostics reconnect the stream; allow the connection to settle before sampling.
Compare diagnostics off/on separately. Input-to-result, actual display cadence,
and impaired/public-network behaviour still require device measurement. Stable
120 fps and stable 4K/60 were not demonstrated by the initial Mac loopback tests.
LTR feedback, content-adaptive tile transport and cross-device presentation-deadline
feedback remain later stages.
