# Native iOS screen preview

This local Expo module owns the WebRTC receiver, decoded-frame mailbox, Metal
presentation and screen gestures. It shares the installed JitsiWebRTC framework
with `react-native-webrtc`. The existing host forwarder carries authenticated
signalling; the media track remains DTLS-SRTP peer to peer.

The screen header offers **低延迟预览** when this module is in the installed iOS
build. **兼容模式** retains the existing viewer, including its shortcut editor.
The preview is opt-in until device and network comparisons pass. It does not
change Android's receiver. Rebuild the iOS app after adding the module; a Metro
reload cannot install native code.

The preview starts with a **60 帧上限** for a like-for-like comparison with the
web viewer. **120 帧上限** requests a higher ceiling; source/receiver refresh rate,
thermal state and transport adaptation still determine the actual frame rate.
Switching this ceiling or diagnostics reconnects the stream. Diagnostics report
sender and decoder output separately; neither is a physical display-rate result.

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
On 2026-10-10, the current receiver built for arm64 iPhone with Xcode 27.1, passed
code-signature verification, and installed/launched on an iPhone Air. This is a
development-signed Release configuration with its JS bundle included, named
**LinkShell Dev** (`com.bd.linkshell.v2`); it does not need Metro. Build/install/
launch evidence does not establish screen performance or interaction correctness.

Current acceptance issue: the user reports a short periodic stutter roughly once
per second or faster in both native and web modes. A native diagnostic snapshot
showed 120 encoded / 116 decoded fps and decode-to-presentation p95 of 30.6 ms.
The cause has not been established or fixed; average throughput is not a pass for
frame pacing. Further diagnosis is deferred while this build is handed over.

Final device acceptance stays separate:

1. On the same Mac build and Wi-Fi, select a moving text/window scene and **2560**.
   Compare **兼容模式** with **低延迟预览 → 60 帧上限**. Leave diagnostics off while
   judging responsiveness, readability and stutter; repeat in both orders.
2. In the native preview, choose **2560** first, then **120 帧上限**. Use a 120 Hz
   source display. Temporarily enable diagnostics to distinguish actual encoded
   and decoded FPS from the requested ceiling. Repeated or decoded frames do not
   by themselves prove 120 different pictures physically presented each second.
3. Check pointer/drag, scroll, keyboard, zoom, rotation, screen selection and
   reconnect/backgrounding. Run for 30 minutes to check heat and sustained cadence.

Diagnostics reconnect the stream; allow the connection to settle before sampling.
Compare diagnostics off/on separately. Input-to-result, actual display cadence,
and impaired/public-network behaviour still require device measurement. LTR
feedback, content-adaptive tile transport and cross-device presentation-deadline
feedback are later stages; they are not implemented by this preview.
