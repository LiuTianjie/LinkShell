import type { DirectConnector } from "@linkshell/client-core";
import { DIRECT_LABEL } from "@linkshell/wire";
import { RTCPeerConnection, RTCSessionDescription } from "react-native-webrtc";

// The phone's end of the direct channel: a WebRTC data channel to the
// computer for the screen and port previews, so they don't go through the
// gateway. Only the data channel is used; no camera or microphone.

/** How long to look for addresses before sending the offer with the ones found. */
const GATHER_MS = 2000;

/** (The library's classes are event targets; its types don't say so.) */
type Listens = { addEventListener(name: string, listener: (event: unknown) => void): void };

export const directConnector: DirectConnector = (iceServers) => {
  const peer = new RTCPeerConnection({ iceServers: iceServers.map((urls) => ({ urls })) });
  const data = peer.createDataChannel(DIRECT_LABEL, { ordered: true });
  data.binaryType = "arraybuffer";
  const connection = peer as typeof peer & Listens;
  const channel = data as typeof data & Listens;
  return {
    async offer() {
      await connection.setLocalDescription(await connection.createOffer({}));
      if (connection.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, GATHER_MS);
          connection.addEventListener("icegatheringstatechange", () => {
            if (connection.iceGatheringState !== "complete") return;
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("no offer could be made");
      return sdp;
    },
    accept: (answer) => connection.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: answer })),
    send: (bytes) => channel.send(bytes),
    onState(listener) {
      channel.addEventListener("open", () => listener("open"));
      channel.addEventListener("close", () => listener("closed"));
      connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed" || connection.connectionState === "closed") listener("closed");
      });
    },
    onMessage(listener) {
      channel.addEventListener("message", (event) => {
        const message = (event as { data: unknown }).data;
        if (message instanceof ArrayBuffer) listener(new Uint8Array(message));
      });
    },
    close: () => connection.close(),
  };
};
