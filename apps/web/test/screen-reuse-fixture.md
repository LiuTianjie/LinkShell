# Screen reuse browser fixture

Run `pnpm --filter @linkshell/web dev` and open
`http://127.0.0.1:5173/test/screen-reuse-fixture.html` in Chrome. This fixture is
not part of the production entry point and needs no additional dependencies.
Reload after source changes; a Vite reload destroys the test's identity baseline.

The fixture mounts the production `ScreenSessionSlot`, `Screen`, iframe bridge,
HTTP/WebSocket framing and Host `viewerPage()`. RPC and streams terminate at a
synthetic Host. That Host sends a visible canvas over a real browser
`RTCPeerConnection`; its synthetic host candidates use loopback to avoid LAN
mDNS/firewall dependence. Keep the source canvas visible so Chrome continues
capturing frames. The source is capped at 30 fps regardless of the requested
receiver cap.

Wait for the receiver state to become `connected` and for the normal viewer
statistics to show decoded frames, then press **Save identity baseline**.

| Action | Expected evidence |
| --- | --- |
| Change width, display or frame-rate cap using the normal Screen dropdowns | `sameIframe`, `sameWindow`, `sameReceiver` stay true; `extraStarts`, `extraOffers`, `extraLoads` stay zero; the latest configuration matches the selection |
| Leave screen route | The same iframe remains mounted but invisible; latest configuration has `paused:true`; source frame count stops increasing |
| Return to screen route | Same iframe and connected PC; latest configuration has `paused:false`; frame count resumes without another start or offer |
| Forge session message source / channel, then leave and return | Forged capability messages are ignored; the capable viewer is still retained |
| Leave, then Expire retained screen now | Actual registered 120,000 ms callback is invoked early; iframe disappears and socket closes once; return creates a new viewer |
| Disconnect host sockets, then leave and return | Disconnection notice is visible; the dead iframe is removed; return starts a fresh viewer even though the fixture HostLink remains online |
| Withhold pause acknowledgement, then leave | After the production two-second safety deadline the iframe is removed and the socket is closed |
| Open Legacy host fixture | No capability/configuration protocol is sent; leaving closes immediately; returning or changing width creates a new viewer |

`receiverClosed` records explicit close messages only while the iframe remains
mounted. It cannot report a close after its browsing context is removed. Use
`iframePresent`, socket close counts and a new receiver ID for disposal evidence.

This covers browser lifecycle, configuration propagation, normal decoded video
and the isolated message bridge. It does not exercise the `ScreenDetail`
computer lease, the real Mac helper/capture/input path, iOS or Android surfaces,
account login, WAN networking, 120 fps delivery or the wall-clock duration of
the accelerated expiry case.
