import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { createEnvelope } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";

const RTP_MTU = 1200; // Max payload size before FU-A fragmentation

export interface ScreenShareOptions {
  sessionId: string;
  fps: number;
  quality: number;
  scale: number;
  turnUrl?: string;
  turnUser?: string;
  turnPass?: string;
  onSignal: (envelope: Envelope) => void;
  onStatus: (envelope: Envelope) => void;
}

/**
 * WebRTC screen sharing using werift (pure TS WebRTC) + ffmpeg.
 *
 * Flow:
 * 1. ffmpeg captures screen → H.264 → writes to stdout as raw annexb
 * 2. We read H.264 NAL units and push them into werift video track
 * 3. werift handles ICE/DTLS/SRTP and sends to remote peer
 * 4. Signaling (SDP offer/answer, ICE candidates) goes through existing WebSocket
 */
export class ScreenShare {
  private pc: any; // werift.RTCPeerConnection
  private ffmpeg: ChildProcess | undefined;
  private active = false;
  private readonly options: ScreenShareOptions;

  constructor(options: ScreenShareOptions) {
    this.options = options;
  }

  static isAvailable(): boolean {
    // Check ffmpeg exists
    try {
      execSync("which ffmpeg", { stdio: "pipe" });
    } catch {
      return false;
    }
    // Check werift can be resolved from this package's context
    try {
      const require = createRequire(import.meta.url);
      require.resolve("werift");
      const werift = require("werift") as any;
      if (!werift.RTCPeerConnection || !werift.MediaStreamTrack) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    try {
      const werift = await import("werift") as any;

      // ICE servers
      const iceServers: any[] = [
        { urls: "stun:stun.l.google.com:19302" },
      ];
      if (this.options.turnUrl) {
        iceServers.push({
          urls: this.options.turnUrl,
          username: this.options.turnUser ?? "",
          credential: this.options.turnPass ?? "",
        });
      }

      this.pc = new werift.RTCPeerConnection({
        iceServers,
        bundlePolicy: "max-bundle",
        codecs: { video: [werift.useH264()] },
      });

      // Create video track — werift defaults to H264, no need to set codecs explicitly
      // (setting transceiver.codecs crashes createOffer in werift 0.22.x)
      const videoTrack = new werift.MediaStreamTrack({ kind: "video" });
      this.pc.addTransceiver(videoTrack, {
        direction: "sendonly",
      });

      // ICE candidate → send to remote
      this.pc.onIceCandidate.subscribe((candidate: any) => {
        if (candidate) {
          this.options.onSignal(
            createEnvelope({
              type: "screen.ice",
              sessionId: this.options.sessionId,
              payload: {
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null,
              },
            }),
          );
        }
      });

      // Connection state changes
      this.pc.connectionStateChange.subscribe((state: string) => {
        if (state === "connected") {
          this.options.onStatus(
            createEnvelope({
              type: "screen.status",
              sessionId: this.options.sessionId,
              payload: { active: true, mode: "webrtc" as const },
            }),
          );
        } else if (state === "failed" || state === "disconnected" || state === "closed") {
          this.options.onStatus(
            createEnvelope({
              type: "screen.status",
              sessionId: this.options.sessionId,
              payload: { active: false, mode: "off" as const, error: `WebRTC ${state}` },
            }),
          );
        }
      });

      // Create offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this.options.onSignal(
        createEnvelope({
          type: "screen.offer",
          sessionId: this.options.sessionId,
          payload: { sdp: offer.sdp },
        }),
      );

      // Start ffmpeg capture (will begin sending once ICE connects)
      this.startFfmpeg(videoTrack, werift);

    } catch (err) {
      this.options.onStatus(
        createEnvelope({
          type: "screen.status",
          sessionId: this.options.sessionId,
          payload: {
            active: false,
            mode: "off" as const,
            error: `WebRTC init failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        }),
      );
      this.active = false;
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    try {
      const werift = await import("werift") as any;
      await this.pc.setRemoteDescription(
        new werift.RTCSessionDescription(sdp, "answer"),
      );
    } catch (err) {
      process.stderr.write(`[screen-share] failed to set answer: ${err}\n`);
    }
  }

  async handleIceCandidate(candidate: string, sdpMid?: string | null, sdpMLineIndex?: number | null): Promise<void> {
    if (!this.pc) return;
    try {
      const werift = await import("werift") as any;
      await this.pc.addIceCandidate(
        new werift.RTCIceCandidate({ candidate, sdpMid: sdpMid ?? undefined, sdpMLineIndex: sdpMLineIndex ?? undefined }),
      );
    } catch (err) {
      process.stderr.write(`[screen-share] failed to add ICE candidate: ${err}\n`);
    }
  }

  stop(): void {
    this.active = false;
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
      this.ffmpeg = undefined;
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = undefined;
    }
    this.options.onStatus(
      createEnvelope({
        type: "screen.status",
        sessionId: this.options.sessionId,
        payload: { active: false, mode: "off" as const },
      }),
    );
  }

  private startFfmpeg(videoTrack: any, werift: any): void {
    const os = platform();
    const fps = this.options.fps;
    const scale = this.options.scale;

    let inputArgs: string[];
    if (os === "darwin") {
      inputArgs = ["-f", "avfoundation", "-framerate", String(fps), "-i", "1:none"];
    } else if (os === "linux") {
      inputArgs = ["-f", "x11grab", "-framerate", String(fps), "-i", ":0"];
    } else {
      inputArgs = ["-f", "gdigrab", "-framerate", String(fps), "-i", "desktop"];
    }

    const scaleFilter = scale < 1 ? ["-vf", `scale=iw*${scale}:ih*${scale}`] : [];

    this.ffmpeg = spawn("ffmpeg", [
      ...inputArgs,
      ...scaleFilter,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
      "-g", String(fps * 2),
      "-b:v", "1500k",
      "-maxrate", "2000k",
      "-bufsize", "4000k",
      "-f", "h264",
      "-an",
      "pipe:1",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // RTP state
    let seqNum = 0;
    let timestamp = 0;
    const clockRate = 90000;
    const frameDuration = Math.floor(clockRate / fps);
    const ssrc = (Math.random() * 0xffffffff) >>> 0;

    // Parse NAL units from annexb stream and packetize as RTP
    let nalBuffer = Buffer.alloc(0);

    const sendNalUnit = (nal: Buffer) => {
      if (nal.length === 0) return;

      // Strip start code
      let offset = 0;
      if (nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) {
        offset = 4;
      } else if (nal[0] === 0 && nal[1] === 0 && nal[2] === 1) {
        offset = 3;
      }
      const nalData = nal.subarray(offset);
      if (nalData.length === 0) return;

      const nalType = nalData[0]! & 0x1f;
      // Update timestamp on each new access unit (SPS/IDR/non-IDR slice)
      if (nalType === 7 || nalType === 5 || nalType === 1) {
        // Only bump timestamp for actual picture NALs (not SPS/PPS)
        if (nalType === 5 || nalType === 1) {
          timestamp += frameDuration;
        }
      }

      if (nalData.length <= RTP_MTU) {
        // Single NAL unit packet
        const header = new werift.RtpHeader({
          sequenceNumber: seqNum++ & 0xffff,
          timestamp: timestamp >>> 0,
          payloadType: 96,
          ssrc,
          marker: nalType === 1 || nalType === 5, // marker on last NAL of frame
        });
        try {
          videoTrack.writeRtp(new werift.RtpPacket(header, nalData));
        } catch {}
      } else {
        // FU-A fragmentation (RFC 6184)
        const fnri = nalData[0]! & 0xe0; // F + NRI bits
        const nalTypeVal = nalData[0]! & 0x1f;
        const fuIndicator = fnri | 28; // FU-A type = 28
        let pos = 1; // skip NAL header byte
        let isFirst = true;

        while (pos < nalData.length) {
          const end = Math.min(pos + RTP_MTU - 2, nalData.length); // -2 for FU indicator + FU header
          const isLast = end >= nalData.length;

          let fuHeader = nalTypeVal;
          if (isFirst) fuHeader |= 0x80; // Start bit
          if (isLast) fuHeader |= 0x40;  // End bit

          const payload = Buffer.concat([
            Buffer.from([fuIndicator, fuHeader]),
            nalData.subarray(pos, end),
          ]);

          const header = new werift.RtpHeader({
            sequenceNumber: seqNum++ & 0xffff,
            timestamp: timestamp >>> 0,
            payloadType: 96,
            ssrc,
            marker: isLast && (nalType === 1 || nalType === 5),
          });
          try {
            videoTrack.writeRtp(new werift.RtpPacket(header, payload));
          } catch {}

          isFirst = false;
          pos = end;
        }
      }
    };

    const extractNalUnits = () => {
      // Find NAL unit boundaries (0x00000001 or 0x000001)
      const units: Buffer[] = [];
      let start = -1;

      for (let i = 0; i < nalBuffer.length - 3; i++) {
        if (nalBuffer[i] === 0 && nalBuffer[i + 1] === 0) {
          let scLen = 0;
          if (nalBuffer[i + 2] === 0 && i + 3 < nalBuffer.length && nalBuffer[i + 3] === 1) {
            scLen = 4;
          } else if (nalBuffer[i + 2] === 1) {
            scLen = 3;
          }
          if (scLen > 0) {
            if (start >= 0) {
              units.push(nalBuffer.subarray(start, i));
            }
            start = i;
            i += scLen - 1; // skip past start code
          }
        }
      }

      if (start >= 0 && units.length > 0) {
        // Keep remaining data from last start code onward
        nalBuffer = nalBuffer.subarray(start);
      } else if (start < 0) {
        // No start code found yet, keep accumulating
      }

      return units;
    };

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (!this.active) return;
      nalBuffer = Buffer.concat([nalBuffer, chunk]);

      const units = extractNalUnits();
      for (const unit of units) {
        sendNalUnit(unit);
      }
    });

    this.ffmpeg.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes("Error") || msg.includes("error")) {
        process.stderr.write(`[screen-share:ffmpeg] ${msg}\n`);
      }
    });

    this.ffmpeg.on("exit", (code) => {
      if (this.active) {
        process.stderr.write(`[screen-share] ffmpeg exited with code ${code}\n`);
        this.stop();
      }
    });
  }
}
