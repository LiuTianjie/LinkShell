import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { createEnvelope } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";

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
    // Check if werift can be imported and ffmpeg exists
    try {
      execSync("which ffmpeg", { stdio: "pipe" });
    } catch {
      return false;
    }
    try {
      require.resolve("werift");
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    try {
      const werift = await import("werift");

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
      });

      // Create video track
      const videoTrack = new werift.MediaStreamTrack({ kind: "video" });
      this.pc.addTrack(videoTrack);

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
      this.startFfmpeg(videoTrack);

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
      const werift = await import("werift");
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
      const werift = await import("werift");
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

  private startFfmpeg(videoTrack: any): void {
    const os = platform();
    const fps = this.options.fps;
    const scale = this.options.scale;

    let inputArgs: string[];
    if (os === "darwin") {
      // macOS: AVFoundation screen capture
      inputArgs = ["-f", "avfoundation", "-framerate", String(fps), "-i", "1:none"];
    } else if (os === "linux") {
      // Linux: X11 screen grab
      inputArgs = ["-f", "x11grab", "-framerate", String(fps), "-i", ":0"];
    } else {
      // Windows: GDI screen grab
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
      "-g", String(fps * 2), // keyframe every 2 seconds
      "-b:v", "1500k",
      "-maxrate", "2000k",
      "-bufsize", "4000k",
      "-f", "h264",
      "-an", // no audio
      "pipe:1",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Read H.264 NAL units from stdout and push to video track
    let nalBuffer = Buffer.alloc(0);

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (!this.active) return;

      nalBuffer = Buffer.concat([nalBuffer, chunk]);

      // Split on NAL unit start codes (0x00000001 or 0x000001)
      let offset = 0;
      while (offset < nalBuffer.length - 4) {
        let startCodeLen = 0;
        if (nalBuffer[offset] === 0 && nalBuffer[offset + 1] === 0) {
          if (nalBuffer[offset + 2] === 0 && nalBuffer[offset + 3] === 1) {
            startCodeLen = 4;
          } else if (nalBuffer[offset + 2] === 1) {
            startCodeLen = 3;
          }
        }

        if (startCodeLen > 0 && offset > 0) {
          // Found a NAL unit boundary
          const nalUnit = nalBuffer.subarray(0, offset);
          try {
            videoTrack.writeRtp(nalUnit);
          } catch {
            // Track might not be ready yet
          }
          nalBuffer = nalBuffer.subarray(offset);
          offset = 0;
          continue;
        }
        offset++;
      }
    });

    this.ffmpeg.stderr?.on("data", (data: Buffer) => {
      // ffmpeg logs to stderr, ignore unless debugging
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
