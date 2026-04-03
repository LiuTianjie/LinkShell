declare module "werift" {
  export class RTCPeerConnection {
    constructor(config?: any);
    onIceCandidate: { subscribe: (cb: (candidate: any) => void) => void };
    connectionStateChange: { subscribe: (cb: (state: string) => void) => void };
    addTrack(track: MediaStreamTrack): void;
    createOffer(): Promise<{ sdp: string; type: string }>;
    setLocalDescription(desc: any): Promise<void>;
    setRemoteDescription(desc: any): Promise<void>;
    addIceCandidate(candidate: any): Promise<void>;
    close(): void;
  }
  export class RTCSessionDescription {
    constructor(sdp: string, type: string);
  }
  export class RTCIceCandidate {
    constructor(init: { candidate: string; sdpMid?: string; sdpMLineIndex?: number });
  }
  export class MediaStreamTrack {
    constructor(init: { kind: string });
    writeRtp(data: Buffer): void;
  }
}
