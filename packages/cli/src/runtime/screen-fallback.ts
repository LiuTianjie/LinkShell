import { execSync, spawn } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { createEnvelope, serializeEnvelope } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";

export interface ScreenFallbackOptions {
  fps: number;
  quality: number;
  scale: number;
  sessionId: string;
  onFrame: (envelope: Envelope) => void;
  onStatus: (envelope: Envelope) => void;
}

const CHUNK_SIZE = 48 * 1024; // 48KB per chunk, leave room for envelope overhead
const TMP_FILE = join(tmpdir(), `linkshell-screen-${process.pid}.jpg`);

export class ScreenFallback {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frameId = 0;
  private active = false;
  private readonly options: ScreenFallbackOptions;

  constructor(options: ScreenFallbackOptions) {
    this.options = options;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.frameId = 0;

    const interval = Math.max(50, Math.floor(1000 / this.options.fps));

    this.options.onStatus(
      createEnvelope({
        type: "screen.status",
        sessionId: this.options.sessionId,
        payload: { active: true, mode: "fallback" as const },
      }),
    );

    // Capture first frame immediately
    this.captureAndSend();

    this.timer = setInterval(() => {
      this.captureAndSend();
    }, interval);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Clean up temp file
    try { if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE); } catch {}

    this.options.onStatus(
      createEnvelope({
        type: "screen.status",
        sessionId: this.options.sessionId,
        payload: { active: false, mode: "off" as const },
      }),
    );
  }

  private captureAndSend(): void {
    if (!this.active) return;

    try {
      const imgBuffer = this.captureScreen();
      if (!imgBuffer || imgBuffer.length === 0) return;

      const base64 = imgBuffer.toString("base64");
      const frameId = this.frameId++;

      // Get dimensions (approximate from JPEG header or use defaults)
      const dims = this.getJpegDimensions(imgBuffer);

      if (base64.length <= CHUNK_SIZE) {
        // Single chunk
        this.options.onFrame(
          createEnvelope({
            type: "screen.frame",
            sessionId: this.options.sessionId,
            payload: {
              data: base64,
              width: dims.width,
              height: dims.height,
              frameId,
              chunkIndex: 0,
              chunkTotal: 1,
            },
          }),
        );
      } else {
        // Split into chunks
        const chunkTotal = Math.ceil(base64.length / CHUNK_SIZE);
        for (let i = 0; i < chunkTotal; i++) {
          if (!this.active) return;
          const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          this.options.onFrame(
            createEnvelope({
              type: "screen.frame",
              sessionId: this.options.sessionId,
              payload: {
                data: chunk,
                width: dims.width,
                height: dims.height,
                frameId,
                chunkIndex: i,
                chunkTotal,
              },
            }),
          );
        }
      }
    } catch {
      // Silently skip failed frames
    }
  }

  private captureScreen(): Buffer | null {
    const os = platform();
    const q = this.options.quality;
    const s = this.options.scale;

    try {
      if (os === "darwin") {
        // macOS: screencapture
        execSync(
          `screencapture -x -t jpg -C "${TMP_FILE}"`,
          { timeout: 3000, stdio: "pipe" },
        );
        if (!existsSync(TMP_FILE)) return null;
        let buf = readFileSync(TMP_FILE);

        // Resize if scale < 1 and sips is available
        if (s < 1) {
          try {
            const w = Math.floor(this.getJpegDimensions(buf).width * s);
            execSync(
              `sips --resampleWidth ${w} -s formatOptions ${q} "${TMP_FILE}" --out "${TMP_FILE}"`,
              { timeout: 3000, stdio: "pipe" },
            );
            buf = readFileSync(TMP_FILE);
          } catch {
            // Use original size if resize fails
          }
        }
        return buf;
      }

      if (os === "linux") {
        // Linux: try import (ImageMagick) or scrot
        try {
          const resizeArg = s < 1 ? `-resize ${Math.floor(s * 100)}%` : "";
          execSync(
            `import -window root -quality ${q} ${resizeArg} jpeg:"${TMP_FILE}"`,
            { timeout: 3000, stdio: "pipe" },
          );
        } catch {
          // Fallback to scrot
          execSync(
            `scrot -q ${q} "${TMP_FILE}"`,
            { timeout: 3000, stdio: "pipe" },
          );
        }
        if (!existsSync(TMP_FILE)) return null;
        return readFileSync(TMP_FILE);
      }

      // Windows: use PowerShell
      if (os === "win32") {
        execSync(
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${TMP_FILE.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Jpeg) }"`,
          { timeout: 5000, stdio: "pipe" },
        );
        if (!existsSync(TMP_FILE)) return null;
        return readFileSync(TMP_FILE);
      }

      return null;
    } catch {
      return null;
    }
  }

  private getJpegDimensions(buf: Buffer): { width: number; height: number } {
    // Parse JPEG SOF marker for dimensions
    try {
      let i = 2; // Skip SOI
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1]!;
        // SOF0, SOF1, SOF2
        if (marker >= 0xc0 && marker <= 0xc2) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          return { width, height };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      }
    } catch {}
    return { width: 1920, height: 1080 }; // Default fallback
  }

  static isAvailable(): boolean {
    const os = platform();
    try {
      if (os === "darwin") {
        execSync("which screencapture", { stdio: "pipe" });
        return true;
      }
      if (os === "linux") {
        try {
          execSync("which import", { stdio: "pipe" });
          return true;
        } catch {
          execSync("which scrot", { stdio: "pipe" });
          return true;
        }
      }
      if (os === "win32") return true; // PowerShell always available
    } catch {}
    return false;
  }
}
