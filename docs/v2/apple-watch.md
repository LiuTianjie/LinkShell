# Apple Watch app

The watchOS 10+ app is generated from `apps/client/plugins/watch/` by
`with-apple-watch.js`. Edit these source files, not generated Xcode targets.
The plugin always creates a watchOS application and a WidgetKit extension,
embeds the extension in the watch app and the watch app in the iPhone app, and
copies the existing app icon into the watch asset catalog. Both targets inherit
the mobile release version/build number and use variant-specific bundle IDs.
The watch app supports independent connections and an optional iPhone companion
mode. `WKRunsIndependentlyOfCompanionApp` is enabled; the watch can sign in or pair
without launching the iPhone app. This remains an embedded watch target in the
same mobile product, not a separate App Store product.

## Independent connections

- Open **连接设置** from the overview or computer picker. Independent mode is the
  default. Sign in with an existing iTool email/password, or run `linkshell pair`
  on the computer and enter its six-digit code on the watch. Third-party-only
  accounts can use pairing; the watch does not implement browser OAuth.
- Account tokens and device private keys stay in the watch's Keychain using
  `AfterFirstUnlockThisDeviceOnly`; widgets only read display snapshots. Refresh
  requests are serialized. Logout removes the account identity because gateway
  identities remain account-bound. Signed-out pairing uses a separate identity;
  custom gateways have their own identities and never receive account tokens.
- watchOS does not permit general-purpose WebSocket connections on physical
  watches ([Apple TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)).
  `WatchRelay.swift` therefore uses foreground HTTPS polling. The gateway exposes
  `POST /v2/poll` to create a temporary transport and `POST /v2/poll/:id` to exchange
  existing v2 frames with a bearer transport secret. Signed nonce authentication,
  pairing/account authorization and X25519 + XChaCha20-Poly1305 end-to-end tunnel
  encryption remain the same as for phones. The host requires no new protocol.
- Each exchange carries a monotonic request number and receive ACK. Retried
  exchanges never reapply frames; outbound frames remain until acknowledged.
  Poll transports have bounded request bodies, buffers, sessions and idle time,
  and share the existing connection rate limiter. `/v2/connect`, the challenge
  string and SQLite pairing schema are unchanged.
- Connections run while the app is active, stop when it leaves the foreground,
  and reconnect on return or connection failure. This does not provide a
  persistent background connection or immediate background approval alerts.
  Complications show the latest cached snapshot under watchOS refresh budgets.
- Switching to iPhone mode uses the existing WatchConnectivity bridge. Switching
  modes clears the displayed computer and cached snapshot. An interrupted action
  never silently falls back to the other transport.

The gateway must be upgraded before distributing the independent app. An older
gateway returns an upgrade message; iPhone mode remains available. The source
change does not deploy the official gateway or replace the previously uploaded
TestFlight binary.

## Interaction

- The overview groups requests needing attention before other sessions, followed
  by terminals. Cards open details; approval choices are not reduced to a pair
  of buttons on the overview. Complex forms direct the user to the phone or computer.
- The overview uses system text styles, neutral dark cards and semantic status
  colors. Primary approval buttons use indigo; amber marks requests for attention.
- Session and terminal details retain collapsed composers and history browsing.
  Approval, command input and other main action buttons have a 44pt minimum height.
- A missing session or terminal shows an unavailable state. It never falls back
  to another item. Cached content is identified when the selected transport is unreachable.

## Command semantics

The connected host is authoritative. In companion mode, the phone sends its
snapshot and acknowledges commands. In independent mode, the watch reads host
summaries/events and sends encrypted RPC directly. It supports session creation,
prompts, cancellation, handoff, advertised settings and simple approvals, plus
terminal creation, output, input and closing. Complex/secret/multiple-choice
forms remain on the phone or computer. Independent decisions recheck the current
request and selected encrypted channel before sending.

User commands are serialized; read-only detail loads can proceed concurrently.
A 15-second UI acknowledgment timeout reports an unknown result and asks for a
state refresh. Transport retries reuse the same request number, and prompts use
stable client message IDs. Offline commands are rejected, not queued for a later
unexpected execution. Switching accounts or computers invalidates outstanding
RPC calls. Notifications arriving during a refresh override the older list result.

## Validation

```sh
pnpm --filter @linkshell/client test
pnpm --filter @linkshell/client typecheck
pnpm --filter @linkshell/client lint
pnpm --filter @linkshell/wire test
pnpm --filter @linkshell/gateway test
pnpm build
pnpm typecheck
LINKSHELL_WATCH_OUTPUT_DIR=/tmp/linkshell-watch-build node apps/client/scripts/run-watch-sim.mjs
```

The native plugin test typechecks the watch app, WidgetKit extension, iPhone bridge
and Live Activity sources on macOS. The simulator script builds, installs and launches the watch app, using an
existing local simulator bridge when available. It does not generate screenshots
or preview galleries.
Use a dedicated output directory and remove its build products after review.
The bridge can operate real host sessions: do not use destructive commands as
visual smoke tests.

Companion validation on 2026-10-17: 200 client tests and 54 wire tests, client TypeScript and
lint, native Swift typechecks, watchOS simulator app/extension builds and visual
inspection of the overview, conversation and terminal screens. The generated
Watch app and its embedded WidgetKit extension also passed an unsigned Release
build for physical watchOS architectures (arm64 and arm64_32). Target graph tests
cover production/development IDs, embedding and repeated plugin execution.
Simulator bridge
rendering does not prove real WatchConnectivity delivery.

Independent-mode validation on 2026-10-17: 203 client tests and 33 gateway tests, full workspace build
and typecheck, watchOS Swift typechecks, simulator pages and unsigned Release
builds for arm64/arm64_32. Native Swift interoperability tests exercise signed
authentication, real pairing proof, encrypted RPC against an isolated WebSocket
host, TS/Swift crypto compatibility, replay/tamper rejection, snapshot decoding,
and mocked token refresh/logout identity isolation. Gateway tests cover retained
responses, mutation retry deduplication, malformed limits and auth races. Public
auth settings confirm email login is enabled; no real account was signed in by
the test. Real Wi-Fi/cellular watch networking and independent installation still
require physical-device validation.

Still requires paired-device validation: phone foreground/background transitions,
watch disconnection and reconnection, physical haptics, VoiceOver and larger text,
complication refresh budgets, and installation of the embedded watch app on a
paired physical device. A signed iOS archive was uploaded to TestFlight on
2026-10-17 as 2.3.32 (20332); Apple processing and real-device acceptance were not
verified. iPhone, Watch and WidgetKit bundle signatures and matching versions
were verified. Xcode reported upload success with non-blocking missing-dSYM
warnings for prebuilt dependencies. Temporary release build products were removed.

## Release path

This includes native Swift and two new embedded targets, so it requires a new
iOS binary. OTA cannot deliver it. The already-uploaded `2.3.32` (20332) contains the earlier companion implementation.
Choose a new version/build for independent mode and recheck remote tags and App
Store Connect before releasing. Deploy the gateway adapter first.

For an iOS-only TestFlight build, run from the repository root:

```sh
node apps/client/scripts/release.mjs ios X.Y.Z
```

That performs a clean production prebuild, signs/archives the iPhone app with the
embedded watch app and extension, and uploads to App Store Connect. Use
`--prepare-only` to export an IPA without uploading. Automatic signing must be
able to provision `com.bd.linkshell.watchkitapp` and
`com.bd.linkshell.watchkitapp.widgets` with the app group `group.com.bd.linkshell`.
Verify the archive contains `Products/Applications/LinkShell.app/Watch/` and
`LinkShellWatch.app/PlugIns/LinkShellWatchWidgets.appex` before distributing.

For the existing combined iOS/Android release lane, use
`./scripts/release-mobile.sh X.Y.Z --yes`; it also publishes Android artifacts to
GitHub. Its config backup now preserves any uncommitted app config changes.
Commit the reviewed source before this lane so the GitHub tag identifies the
actual source built. Paired-device checks above remain necessary before wider
release. Clean only this run's temporary build outputs after artifact delivery.
