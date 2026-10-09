# @linkshell/mac

LinkShell.app: the Mac side of LinkShell's remote desktop. It captures a display, sends it to a
viewer (as a WebRTC video track, or encoded for the host to pass on), and posts the viewer's
pointer and key events. The LinkShell host (`@linkshell/host`) starts it and talks to it over a
unix socket; nobody starts it by hand.

It has no place in the Dock (`LSUIElement`) and one window, shown only when asked for
(`--setup`): the one in which the user gives it its two permissions. macOS 13 or later, on
Apple silicon only: there is no build for Intel Macs.

## Why it is an app

macOS gives Screen Recording and Accessibility to the *responsible app* of a process, not to the
process. A program the host started as its child would be the terminal's (or the IDE's) to be
allowed, and would have to be allowed again in the next terminal. Opened through `/usr/bin/open`,
LinkShell.app is its own responsible app: the two switches in System Settings › Privacy &
Security say "LinkShell", and they hold whichever terminal started the host and however often
the CLI is upgraded.

The system keeps those permissions against a **signing identity and a bundle id**
(`com.bd.linkshell.host`, signed with the project's Developer ID Application certificate).
Change either and every user is asked again: don't. It has also been seen to ask again about
recording for the same app run from another path, so the host always unpacks it to the same
place, and the tools here run the one in `build/` and no copy.

From macOS 15 the system also asks the user, from time to time, whether a program that records
the screen directly may go on doing so ("… is requesting to bypass the system private window
picker …"). That question is the system's own: nothing here causes it or can answer it (the
entitlement that waives it, `com.apple.developer.persistent-content-capture`, has not been
applied for).

## The setup window

```bash
/usr/bin/open -n -a LinkShell.app --args --setup [--quiet-if-done]
```

The first time the screen is wanted, the host (or `linkshell screen`) opens the app so, and the
user sees one small window instead of the system's bare dialogs, one after the other:

- the app's icon, "Let your phone see and control this Mac", and a row for each permission, in
  this order: **Screen & System Audio Recording** ("Screen Recording" before macOS 15), which
  lets the phone show the screen, and **Accessibility**, which lets it move the pointer, click
  and type. Each row says whether it is on. The first one still off is the one put forward
  (its button answers Return); the other is fainter, and works all the same.
- A row's button, "Open System Settings", has the system make its own request the first time it
  is pressed for that permission (`CGRequestScreenCaptureAccess`,
  `AXIsProcessTrustedWithOptions` with the prompt: this is what puts LinkShell in the list),
  and every time opens System Settings at the list with the switch
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`,
  `…?Privacy_Accessibility`; both open the right page on macOS 26). The row then says what to
  do there — turn on LinkShell's switch — and the window moves beside System Settings' window
  (to an edge of the screen when there is no room beside it, or no such window after three
  seconds), so that both can be seen.
- Once a second it looks at what is allowed (Screen Recording through a fresh copy of the app,
  see `Permissions.recording`: a running process is not told of its own grant) and ticks the
  rows off by itself. A row that turns green brings the window to the front.
- After the Screen Recording switch is turned on, System Settings says that LinkShell "may not
  be able to record the contents of your screen until it is quit", with **Later** and **Quit &
  Reopen**. The row says beforehand that Later will do, and it does: the row is ticked through
  the fresh copy. Because System Settings wants an answer just then, this tick puts the window
  in front without taking the keyboard. Quit & Reopen quits the window's process and opens the
  app again with no arguments, which is the setup window again (below): nothing is lost.
- With both on it says "All set" for 2.5 seconds and closes. "Not Now", Escape, ⌘W and the
  close button close it at any time. Closing it ends the process.

Opened when both are already on, it says "All set" for those 2.5 seconds; with
`--quiet-if-done` it exits at once and shows nothing, and no app loses the keyboard for it.
There is one such window at a time (a lock on a file in the user's temporary directory): a
second `--setup` brings the first to the front and exits. The words are Chinese when the
language the user put first is Chinese, and English otherwise (`SetupText.swift` has them all).

Nothing tells the host how it went: it asks its own app for `status`, as often as it likes.

The app is also the setup window when the system opens it with no arguments at all — someone
double-clicked it, or System Settings reopened it.
Started with `--setup` as some program's child it has the system open it
anew and exits: a child would show, and ask for, its parent's permissions.

**Seeing it without touching the system's permissions.** `--pretend none|recording|control|both`
makes the window believe that state; `--pretend-after <seconds> <state>` (any number of them)
changes it later, which is how the ticks, the coming forward and the closing are seen.
Pretending, a button asks the system nothing and opens no settings (the window still steps
aside), and `--pressed` presses the first missing row's button as the window opens.
`--snapshot <file.png>` draws the window's content into a file, at twice its size, and exits
without showing anything; `--appearance light|dark` says which look, and the system's own
`-AppleLanguages '(zh-Hans)'` which language. A snapshot is of a window that is not in front:
the button put forward is drawn in the accent colour only on the screen.

```bash
open -W -n -g -a build/LinkShell.app --args --setup --pretend recording --pressed \
  --appearance dark --snapshot /tmp/setup.png -AppleLanguages '(zh-Hans)'
open -n -a build/LinkShell.app --args --setup --pretend none --pretend-after 3 recording --pretend-after 5 both
```

## The display

A viewer of a Mac whose display has gone to sleep sees black, and can do nothing about it. So
while a video session (`rtc.open` to its end) or a stream (`stream.open` to its end) is open
the app holds a power assertion that keeps the display from sleeping for want of someone at the
Mac (`PreventUserIdleDisplaySleep`), and each session that opens declares user activity, which
wakes a display that was asleep, as a key press does (`Awake.swift`). The last session closing
lets both go, and so does the app ending; nothing is held while nobody watches.
`pmset -g assertions` shows them, named "LinkShell: this screen is being watched from another
device".

It does not unlock a locked screen (the viewer sees the login window), it can't wake a display
that isn't there (a closed lid with no other display), and it doesn't keep the Mac itself from
sleeping when the lid is closed or the user chooses Sleep.

## How it ships

A package manager can't carry the app as it is: npm leaves out the framework's symbolic links,
pnpm the program's permission to run. The package carries one file,
`build/LinkShell.app.tar.gz`; `@linkshell/host` has this package as an optional dependency
(`os: darwin`, `cpu: arm64`) and unpacks the archive with `/usr/bin/tar -xzf` into `~/.linkshell/LinkShell.app`,
once per archive (by its SHA-256). In a checkout the host uses `build/LinkShell.app` directly.

## Build and check

Needs macOS and Xcode's Swift. libwebrtc comes as a prebuilt framework (M154, unmodified
upstream, from `stasel/WebRTC`; see `Package.swift`), fetched by SwiftPM on the first build.

```bash
node scripts/build-app.mjs        # pnpm build: build/LinkShell.app and build/LinkShell.app.tar.gz
pnpm test                         # swift test: what needs no screen and no network (Tests/)
pnpm check                        # that, then pass or fail for the built app, in about a minute
```

`build-app.mjs [--out <directory>]` builds for arm64, embeds the framework (its arm64 half),
signs from the inside out (hardened runtime, timestamp), swaps the
finished bundle into place, packs the archive and proves that the archive unpacks into an app
whose signature verifies. It signs with the "Developer ID Application" identity in the keychain,
or the one `LINKSHELL_SIGN_IDENTITY` names. Without one it signs ad hoc: that app runs, but is
another app to the system, with permissions of its own — not for release.
`LINKSHELL_REQUIRE_SIGNED=1` (set by `prepack`) makes a missing identity fatal. The app is not
notarized yet.

The tools in `tools/` open the app in `build/` the way the host does. None of them posts an
event to the system or has it ask for a permission; the ones that record need Screen Recording to be allowed for LinkShell
already, and stop if it is not rather than have the system ask.

| Tool | What it does |
|---|---|
| `input-check.mjs` | The app's hands in a dry run: the same events down the socket, on stdin and down the data channels have to come out the same. `--shapes` also changes the pointer's picture for a moment. Part of `check`. |
| `stream-check.mjs` | The stream for the host's socket: record format, rates, key frames, change of size, beside a video track; decoded by ffmpeg where installed, and by Chrome's WebCodecs unless `--no-chrome`. Part of `check`. |
| `app-smoke.mjs` | Opens the app, asks for an offer, says what it holds. Part of `check`. |
| `loopback.mjs` | The video track with no viewer: the app answers its own offer, and both ends' numbers are printed. Without `--fps`, at the app's own choice of frame rate; `--fps 30,60` holds each of those. `--narrow <bit/s>:<from second>:<for seconds>` holds the bandwidth estimate down for a while, prints every second, and says what each change of frame rate cost; `--timeline`, `--seconds 10`, `--motion`, `--still`, `--encoder own\|stock`, `--json <file>`; the rest in its header. |
| `flexfec-check.mjs` | A short functional check over its own loopback UDP proxy: 60 ms each way, every twentieth original video packet dropped. Checks real FlexFEC packet receipt, then successful video without FlexFEC when the test receiver declines it. `--json <file>` saves the evidence. No system network changes or latency claims. |
| `setup-shots.mjs` | The setup window drawn into PNG files in every state, light and dark, Chinese and English (24 of them, in `build/setup-shots` or the directory named), with nothing shown and nothing asked of the system. For looking at the window after changing it. |
| `app.mjs`, `h264.mjs`, `pointer-shapes.swift` | Shared by the above: opening the app, reading H.264, changing the pointer's picture. |

The host's own tests run its real code against this app: `packages/host/test/app.test.ts`, and
`packages/host/scripts/screen-check.ts` with a real viewer page.

## Command line

| Mode | |
|---|---|
| `--connect <socket>` | The app as the host uses it: connects to that unix socket and serves the protocol below. The socket closing ends the app. |
| `<screen> [--dry-run]` | One viewer's hands on that display, for a host that could not have the system open the app: input events on stdin, `ready` / `trusted` / `cursor` / `posted` on stdout, no `v`. stdin closing ends it. As a child, the permission is its parent's. |
| `--status` | Prints `status` and exits. |
| `--setup`, or no arguments when the system opened it | The setup window (above). `--quiet-if-done`, `--pretend`, `--pretend-after`, `--pressed`, `--snapshot`, `--appearance` go with it. |

| Flag | |
|---|---|
| `--dry-run` | Events are reported (`posted`), not posted; `trusted` is always true. |
| `--clock` | Shows the clock strip on a display while it is sent (see Measuring). `status` gains `clock`. |
| `--motion` | Shows a window of scrolling text and a sliding block on a display while it is sent: a busy screen's work for the encoder, the same every run. |
| `--loopback` | Each `rtc.open` is answered inside the app by a second connection that decodes the track. Adds `rtc.loopback*` (below). |
| `--encoder own\|stock` | The video track's H.264 encoder: the app's low-latency one (`LowLatencyEncoder.swift`), or libwebrtc's VideoToolbox encoder with the level fixed (`Encoders.swift`). Default `own`; initialization or encoding failures switch to stock for the rest of that encoder's lifetime. |
| `--no-low-latency` | Never asks VideoToolbox for the low-latency rate control: encodes as a Mac without it does. |
| `--no-playout-delay` | Leaves out the field trial that sends playout-delay 0. |
| `--no-flexfec` | Disables FlexFEC advertisement and sending for an explicit comparison. |
| `--loopback-no-flexfec` | Makes the test receiver decline FlexFEC through codec preferences, to check an unsupported viewer's path. |
| `--loopback-network` | Only with `--loopback`: passes its ICE candidates to `flexfec-check.mjs`, which supplies proxy candidates. The proxy exists only while that tool runs. |
| `--trial <name>=<value>` | Another libwebrtc field trial (repeatable). |
| `--rtc-log` | libwebrtc's log, as `log` messages. |

## The socket

One JSON object a line, UTF-8, each way. `→` is host to app, `←` app to host. `v` is an id the
host chooses; the app says it back on everything that belongs to it. A `screen` is a number in
the system's list of active displays, 0 the main one; every command that takes one defaults to
0. Unknown messages are ignored.

### Permissions and displays

| | Message | |
|---|---|---|
| ← | `{t:"status", trusted, recording, app, video:true, w, h, version, clock?}` | The first message, and the answer to `status`. `trusted`: may post events (Accessibility). `recording`: may record the screen. `app`: the responsible app's name, as the privacy settings list it. `w`, `h`: the main display in pixels. `clock`: with `--clock`, `"target"` (the strip shows the time each refresh will be on the glass) or `"drawn"` (before macOS 14: the time it was drawn). |
| → | `{t:"status"}` | |
| ← | `{t:"trusted", on}` | Accessibility was given or taken away (looked at every 250 ms). |
| → | `{t:"displays"}` | |
| ← | `{t:"displays", list:[{screen, id, name, w, h, scale, main}]}` | `w`, `h` in pixels; `scale` pixels to a point; `id` the system's display id. |
| ← | `{t:"log", message}` | For the host's log. |

Nothing on the socket makes the system ask for a permission: only a button in the setup window
does. A session that needs a permission it doesn't have is refused with an error; it never
asks.

### A viewer's hands

| | Message | |
|---|---|---|
| → | `{t:"open", v, screen}` | Any number of viewers at once. An `open` for a `v` that is open replaces it. |
| ← | `{t:"ready", v, trusted, w, h, app}` | `w`, `h`: that display in points. |
| → | an input event with `v` | See below. Dropped while not `trusted`. |
| ← | `{t:"cursor", v, x, y}` | Where the pointer is, as fractions of the viewer's display, when something other than this viewer moved it there (looked at every 250 ms; the pointer is the viewer's own for 0.3 s after each of its events). |
| ← | `{t:"posted", v, kind, …}` | Dry run only: each system event that would have been posted. |
| → | `{t:"close", v}` | Lets go of any button the viewer holds. |

Input events (the host checks them with `inputEvent` in `packages/host/src/input.ts`; on the
socket the app takes them as they come):

| Event | |
|---|---|
| `{t:"move", x, y}` | Fractions (0–1) of the display. A drag while a button is down. |
| `{t:"down"\|"up", b:"left"\|"right", n?, m?}` | `n`: 1–3, the click count. `m`: of `cmd`, `shift`, `alt`, `ctrl` — pressed as keys before the button goes down and held until it is up (`m` on `up` is not read). A `down` for a button already down does nothing. |
| `{t:"scroll", dx, dy, m?}` | Pixels, each held to ±2000. |
| `{t:"key", k, m?}` | `k`: `return tab space backspace escape delete left right up down home end pageup pagedown f1`…`f12`, or a character, found on this Mac's own keyboard layout. An unknown name does nothing. |
| `{t:"text", s}` | 1–4000 UTF-16 units, typed as written whatever the layout. While text comes the Mac types with its plain layout (an input method would compose the letters again); the user's input source is back 2.5 s after the last of it. |
| `{t:"prompt"}` | The viewer asked to be allowed to control this Mac: the app opens its setup window (`--setup --quiet-if-done`, in a process of its own). Nothing in a dry run. |

`posted` kinds: `move`/`drag` `{x, y}` (points, among the displays), `down`/`up`
`{b, n, x, y, flags}`, `moddown`/`modup` `{k}`, `scroll` `{dx, dy}`, `keydown`/`keyup`
`{k, code, flags}`, `textdown`/`textup` `{s}`.

### The screen as a video track: `rtc.*`

One at a time. An `rtc.open` while one is open closes that one, without a word to its viewer,
and takes its place; what is then said for the earlier `v` is dropped.

| | Message | |
|---|---|---|
| → | `{t:"rtc.open", v, screen?, iceServers?, maxWidth?, fps?, codec?}` | `iceServers`: `[{urls, username?, credential?}]`, `urls` a string or a list. `maxWidth`: default 1920, at least 160; the picture is never larger than the display. `fps`: 1–60, the one rate to send at; left out, 60, and 30 while 60 is not being carried (see Tuning). `codec`: `"h264"` (default) or `"hevc"`, which this build of libwebrtc can't encode: H.264 is offered, and a `log` says so. |
| ← | `{t:"rtc.offer", v, sdp}` | The app offers: one send-only video track, and the four data channels. |
| → | `{t:"rtc.answer", v, sdp}` | |
| ↔ | `{t:"rtc.ice", v, candidate, sdpMid, sdpMLineIndex}` | Trickled, either way. Gathering goes on for the life of the session, so a viewer that changes network is found again. |
| ← | `{t:"rtc.state", v, ice, connection}` | On every change of either, named as a browser names them. |
| ← | `{t:"rtc.stats", v, …}` | Once a second: `bitrate` (bit/s), `fps` (frames encoded), `frameRate` (the rate in force: 60 or 30, or the one `rtc.open` named), `frameRateReason` (why it last changed, as the `log` said it; `null` while it hasn't), `width`, `height`, `encoder`, `hardware`, `codec`, `fmtp`, `keyFrames`, `qualityLimitation`, `targetBitrate`, `availableOutgoing`, `rttMs`, `packetsLost`, `nack`, `pli`, `encodeMs`, `sendDelayMs`, `hugeFrames`, `captureFps`, `repeated` (the last picture sent again), `gapMs` (the longest libwebrtc went without a picture, new or repeated), `heard` (messages received on each channel), `clock` (with `--clock`: the strip as captured against the time it was displayed, `{n, unreadable, min, median, max}` in ms). A number libwebrtc doesn't have is `null`. |
| ← | `{t:"rtc.error", v, message}` | The session has ended, and why. |
| → | `{t:"rtc.close", v}` | |

`rtc.error` messages: `screen recording is not allowed for LinkShell`, `there is no display N`,
`the screen could not be captured: …`, `the capture stopped: …`, `the peer connection could not
be made`, `the video could not be added`, `no offer: …`, `the offer was not set: …`,
`the answer was not taken: …`.

The picture has no pointer in it; the viewer draws one from `cursor` and `shape`. A failed
connection does not end the session: the host closes it.

`rtc.stats.flexfec` reports SDP evidence: `{state, payloadType, mediaSSRC, repairSSRC}`. The
state is `not-offered`, `awaiting-answer`, `declined`, `missing-ssrc` or `negotiated`. The last
means the answer accepted the codec and the offer has an FEC-FR protection group; it does not
claim that protection packets have been needed or that a loss was repaired.

With `--loopback`: `← {t:"rtc.loopback", v, …}` once a second (the receiving end's numbers,
among them `gapMs`, the longest it went without a decoded frame, and with `--clock` `latency`
`{n, min, p50, p95, max}`: glass to decoded, ms). `fecPacketsReceived` and `fecBytesReceived`
are the receiver's protection counters (`null` when unavailable), not recovery counts.
The test control messages are
`→ {t:"rtc.loopback.limit", v, bitrate?}` to hold the sender's bandwidth estimate to so many
bits a second, as a narrow network does (without its loss and delay), or without `bitrate` to
let it go,
`← {t:"rtc.loopback.channel", v, channel}` when a channel opens there,
`→ {t:"rtc.loopback.send", v, channel, events:[…]}` to send messages up one, and
`← {t:"rtc.loopback.heard", v, channel, bytes, message}` for each that came down one.
With `--loopback-network`, `↔ {t:"rtc.loopback.ice", v, candidate, sdpMid, sdpMLineIndex}`
exchanges the test receiver's ICE candidates with the tool. Normal viewers never use it.

**FlexFEC.** M154 needs both `WebRTC-FlexFEC-03-Advertised=Enabled` (send codec) and
`WebRTC-FlexFEC-03=Enabled` (protection SSRC and sending). They are on by default. Codec
preferences retain `flexfec-03`; libwebrtc negotiates it normally and produces the FEC-FR
group for our single video stream. A viewer which declines it continues with H.264 and
NACK/RTX. There is no SDP rewriting to pretend a viewer supports it. See M154's
[video engine](https://webrtc.googlesource.com/src/+/refs/branch-heads/8037/media/engine/webrtc_video_engine.cc),
[stream negotiation](https://webrtc.googlesource.com/src/+/refs/branch-heads/8037/pc/media_session.cc), and
[FEC sender creation](https://webrtc.googlesource.com/src/+/refs/branch-heads/8037/call/rtp_video_sender.cc).

Upstream [M124](https://webrtc.googlesource.com/src/+/refs/branch-heads/6367/media/engine/webrtc_video_engine.cc)
already exposes FlexFEC receive support unless explicitly disabled; the installed Jitsi build
and WKWebView still have to prove their capability in their actual answers. A clean network
can negotiate FlexFEC and send no repair packets, because M154's protection controller uses
loss and RTT to choose redundancy. The advertised `repair-window=10000000` is a required
format parameter which this upstream implementation does not use as a ten-second playback
wait. `flexfec-check.mjs` checks actual packet receipt under injected loss; it does not measure
real-device recovery, visual stalls or latency. Those remain phone acceptance checks.

### The data channels

Made by the app, in the offer. Every message is JSON text.

| Label | Delivery | Direction | Carries |
|---|---|---|---|
| `input` | ordered, reliable | viewer → app | Input events: what must arrive. |
| `pointer` | unordered, sent once | viewer → app | Input events a later one replaces or that can be missed (`move`, `scroll`). |
| `cursor` | unordered, sent once | app → viewer | `{t:"cursor", x, y, i}`: every place the pointer is on this display, as fractions of it, at most 60 a second. `i` counts up: the viewer drops one older than the last it drew. |
| `shape` | ordered, reliable | app → viewer | `{t:"shape", id, png, w, h, hotX, hotY, scale, displayW, displayH}` the first time this viewer meets a pointer picture, `{t:"shape", id}` after that. `png` base64; `w`, `h`, `hotX`, `hotY` in points; `scale` the PNG's pixels to a point (2); `displayW`, `displayH` the display in the same points. Looked at 5 times a second. |

Events on `input` and `pointer` are the input events above, with an optional `i`. Here the app
is the one that checks them: a message that is not exactly one of the events (or is over 64 000
bytes) is dropped. They act on the session's display, and in a dry run their `posted` goes to
the socket with the session's `v`.

**Order.** The two channels keep no time with each other, and `pointer` none of its own. A
viewer numbers its events with `i`, one count over both channels. A `move` from `pointer` whose
`i` is lower than the highest already applied is dropped: it would drag from a press to a place
the finger had left. Everything on `input` is applied, in the order sent. Events without `i`
are never dropped.

A button the viewer holds is let go when the connection is `disconnected`, `failed` or `closed`,
when `input` closes, on `rtc.close`, and when the socket closes.

### The screen for the host's socket: `stream.*`

For a viewer the track can't reach: H.264 encoded here and written to a second unix socket of
the host's, which sends it on down a path that loses nothing. The pointer is in the picture.
One stream a `v` (a `stream.open` for a `v` that has one replaces it); streams of different `v`,
and a stream beside an `rtc` session, run independently.

| | Message | |
|---|---|---|
| → | `{t:"stream.open", v, socket, screen?, width?, fps?, bitrate?, ceiling?, gop?, profile?}` | `socket`: the path the app connects to and writes records on. `width`: the widest the picture may be, default 1920, at least 160. `fps`: default 30, 1–60. `bitrate`: bit/s on average, default 2 000 000, at least 50 000. `ceiling`: the most in any one second, never below `bitrate`. `gop`: seconds between key frames at most, default 1, at least 0.2. `profile`: `"baseline"` or `"high"`; left out, High from the low-latency encoder and Baseline from the usual one. |
| → | `{t:"stream.set", v, width?, fps?, bitrate?, ceiling?}` | Takes effect without the stream stopping. |
| → | `{t:"stream.key", v}` | The next frame is a key frame, and goes now. |
| ← | `{t:"stream.started", v, width, height, fps, generation, mode, profile, hardware}` | After the first frame of each generation is written. `mode`: `"low-latency"` or `"real-time"`, the rate control the encoder gave. |
| ← | `{t:"stream.stats", v, width, height, generation, captured, fps, keyFrames, dropped, bitrate, quantizer, encodeMs, waiting}` | Once a second, about that second. `dropped`: frames the encoder dropped to keep to the rate. `waiting`: bytes written that the host has yet to read. |
| ← | `{t:"stream.ended", v, error}` | It ended by itself. Never sent after `stream.close`. |
| → | `{t:"stream.close", v}` | The stream's socket closes. |

`stream.ended` errors: `not a stream: no socket`, `screen recording is not allowed for
LinkShell`, `there is no display N`, `the host's socket could not be reached`, `the host's
socket closed`, `the screen could not be captured: …`, `the capture stopped: …`, `the encoder
could not be started: …`, `the encoder failed: …`, `the encoder's frame could not be read`.

**A record**, one a frame:

```
4 bytes   the frame's length, big-endian
1 byte    flags: bit 0, a key frame
1 byte    generation: one more (wrapping at 256) each time the picture's size changes
          the frame: one access unit in Annex B (00 00 00 01 before each NAL unit), no access
          unit delimiter
```

A key frame has its SPS and PPS in front and is where a decoder can begin. The first frame of a
generation is one, and a decoder has to begin again there (a new size). No frame waits on a
later one: there are no B-frames, and the stream says so (`max_num_reorder_frames` 0, or the
Baseline profile, which has no reordering), so each can be shown as it is decoded. The colours are BT.709, video range, and the stream says so.

What is sent: frames at `fps` and no faster. While the screen is still nothing is captured and
next to nothing sent — the last picture again until it is sharp (quantizer 24, or 1.5 s), and
a key frame every `gop` seconds. A key frame is sized for 0.4 of a second's bits (0.8 on a still
screen). With half a second of the stream written and unread by the host, or two frames still
in the encoder, no more frames are made until there is room. An encoder that fails is made
again once.

## Tuning

`Sources/LinkShell/Tuning.swift` has the numbers that shape the picture, each with its reason:
the defaults (1920 wide; 60 frames for the track, 30 for the stream), the track's ceiling (8 Mbit/s for 1920×1080 at 30, in
proportion to the pixels, half as much again above 30, between 2 and 16) and where its
bandwidth estimate starts (2 Mbit/s), the degradation preference (the picture gets smaller, not
jerkier), the field trials (playout-delay 0), how much more than the frame rate the capture is
asked for (1.1×), how often a still screen's picture is sent again (every 0.1 s for a second,
then every 0.5 s), the pointer's rates (60 and 5 a second), and everything about the stream's
pacing and key frames.

**The track's frame rate** (`FrameRate.swift`, a rule with no clock and no network in it,
tested in `Tests/`; what a change takes is `ScreenSession.change`). A session that `rtc.open`
gave no `fps` starts at 60 and is judged once a second, while its connection is up, on the
numbers `rtc.stats` says:

- **Down to 30** when, for 3 seconds running, the picture sent has under 0.9 of the captured
  picture's pixels (libwebrtc made it smaller: too little bandwidth, or too little processor),
  or the screen gives at least 0.8 of the rate and under 0.75 of what it gives is encoded.
  Packets lost, a low estimate while the picture is whole, and the encoder's time over a frame
  are not reasons.
- **Back to 60** when, for 10 seconds running at 30, the picture is whole, libwebrtc says
  nothing limits it, frames are not being lost and the bandwidth estimate is at least 0.4 of
  the ceiling at 60 (4.8 Mbit/s for 1920×1080). The 10 seconds double, up to 160, each time 60
  is lost again within 30 seconds of being tried.
- Nothing is concluded in a connection's first 4 seconds, nor in the 4 after each change.

A change is made with the capture running and nothing negotiated: ScreenCaptureKit's frame
interval, the sender's `maxFramerate` and its ceiling. Going down, a picture libwebrtc had
shrunk is whole again from the next frame (a key frame) and stays so for 4 seconds, after which
libwebrtc may shrink it again; going up, the first second may send half of what 30 was sending.
Each change is a `log`: `frame rate 60 → 30: the picture was being shrunk for 3 s (bandwidth)`,
`frame rate 30 → 60: nothing limited the picture for 10 s, and the network is estimated at
9.8 Mbit/s`.

Elsewhere: the quantizers at which libwebrtc resizes the picture (the encoders say 28 and 39,
`LowLatencyEncoder.swift`; libwebrtc goes by its own for H.264, 24 and 37, as its log says), the sizing of key frames (`VideoCompressor.swift`), the 0.3 s after an event in
which the pointer is the viewer's own and the ±2000 on a scroll (`Control.swift`), the pause
and the 2.5 s around the input source (`Keys.swift`), and the pointer picture's scale
(`PointerShape.swift`).

## Measuring

| What | Where |
|---|---|
| The sending side alone: capture and encode rates, encode time, bitrate, CPU, and with the strip the time from the glass to a decoded frame inside the app | `node tools/loopback.mjs` (`rtc.stats`, `rtc.loopback`) |
| The frame rate changing: when it goes down and comes back, the longest wait for a frame across each change, the picture's size before and after | `node tools/loopback.mjs --motion --seconds 60 --narrow 1750000:5:20` |
| The stream: frame rate and bitrate against what was asked, key frame sizes and quantizers, encode time, the stall at a change of size, CPU | `node tools/stream-check.mjs` |
| Glass to glass in a real viewer page, over either path | The host with `LINKSHELL_SCREEN_CLOCK=1` (it passes `--clock`) and the page with `?measure=1`; unattended, `packages/host/scripts/screen-check.ts` |
| How far the strip itself is from the truth | `clock` in `rtc.stats` |

**The clock strip** (`--clock`, `ClockStrip.swift`): a borderless window above everything on the
display being sent, from x 0.05 to 0.45 and y 0.10 to 0.14 of the display. 20 cells of equal
width: white, black, the 16 bits (highest first, white is 1) of `gray(T)`, black, white, with
`T` the milliseconds since 1970 mod 65536 at which that refresh is on the glass and
`gray(n) = n ^ (n >> 1)`. To read it: sample the middle of each cell on the row at y 0.12; the
frame doesn't count unless the white cells are at least 80 (of 255) brighter than the black;
a bit is 1 above the midpoint; undo the Gray code; the latency is the reader's clock minus `T`,
mod 65536, and more than 30 s is a misreading. The viewer page reads the same strip.

Results are kept with the design, not here: `docs/v2/screen-realtime.md` §9 in the repository.
