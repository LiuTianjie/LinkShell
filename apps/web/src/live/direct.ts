import type { DirectConnector } from "@linkshell/client-core";
import { DIRECT_LABEL } from "@linkshell/wire";

export const browserDirect: DirectConnector = (iceServers) => {
  const peer = new RTCPeerConnection({
    iceServers: iceServers.map((urls) => ({ urls })),
  });
  const channel = peer.createDataChannel(DIRECT_LABEL, { ordered: true });
  channel.binaryType = "arraybuffer";
  return {
    async offer() {
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            peer.removeEventListener("icegatheringstatechange", check);
            resolve();
          };
          const check = () => {
            if (peer.iceGatheringState === "complete") finish();
          };
          const timer = setTimeout(finish, 2000);
          peer.addEventListener("icegatheringstatechange", check);
        });
      if (!peer.localDescription?.sdp) throw new Error("无法建立直连通道");
      return peer.localDescription.sdp;
    },
    accept: (sdp) => peer.setRemoteDescription({ type: "answer", sdp }),
    send(bytes) {
      channel.send(bytes as Uint8Array<ArrayBuffer>);
    },
    onState(listener) {
      channel.addEventListener("open", () => listener("open"));
      channel.addEventListener("close", () => listener("closed"));
      peer.addEventListener("connectionstatechange", () => {
        if (["failed", "closed"].includes(peer.connectionState))
          listener("closed");
      });
    },
    onMessage(listener) {
      channel.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer)
          listener(new Uint8Array(event.data));
      });
    },
    close() {
      peer.close();
    },
  };
};
