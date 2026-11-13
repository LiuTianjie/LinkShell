import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackChild } from "./children.js";

export interface MdnsAdvertiseOptions {
  port: number;
  machineId: string;
  fingerprint: string;
  protocolVersion: number;
  platform?: NodeJS.Platform;
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
  log?: (message: string) => void;
}

function sanitizeToken(raw: string, maxLength = 64): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, maxLength);
}

/**
 * Computes a short, non-identifying fingerprint from `identity.json`'s public id
 * (or falls back to a hash of `machineId`), never exposing usernames or paths.
 */
export function hostFingerprint(home: string, machineId: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(home, "identity.json"), "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id) {
      return createHash("sha256").update(parsed.id).digest("hex").slice(0, 24);
    }
  } catch {
    // Identity file may not exist until GatewayLink or LAN pairing initializes it.
  }
  return createHash("sha256").update(`linkshell-machine:${machineId}`).digest("hex").slice(0, 24);
}

export function buildMdnsCommand(options: {
  port: number;
  machineId: string;
  fingerprint: string;
  protocolVersion: number;
  platform?: NodeJS.Platform;
}): { command: string; args: string[]; instanceName: string; txtRecords: string[] } | undefined {
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) return undefined;
  const safeMid = sanitizeToken(options.machineId, 64);
  const safeFp = sanitizeToken(options.fingerprint, 48);
  if (!safeMid || !safeFp) return undefined;

  const instanceName = `linkshell-${safeFp.slice(0, 8)}`;
  const txtRecords = [`v=${options.protocolVersion}`, `mid=${safeMid}`, `fp=${safeFp}`];

  if (platform === "darwin") {
    return {
      command: "/usr/bin/dns-sd",
      args: ["-R", instanceName, "_linkshell._tcp", "local", String(options.port), ...txtRecords],
      instanceName,
      txtRecords,
    };
  }
  if (platform === "linux") {
    return {
      command: "avahi-publish-service",
      args: [instanceName, "_linkshell._tcp", String(options.port), ...txtRecords],
      instanceName,
      txtRecords,
    };
  }
  return undefined;
}

export class MdnsAdvertiser {
  private child?: ChildProcess;
  private stopped = false;

  constructor(private readonly options: MdnsAdvertiseOptions) {}

  get active(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  start(): boolean {
    if (this.stopped || this.child) return this.active;
    const spec = buildMdnsCommand(this.options);
    if (!spec) return false;
    const spawnFn =
      this.options.spawnProcess ??
      ((command: string, args: string[]) => spawn(command, args, { stdio: "ignore", windowsHide: true }));
    try {
      const child = spawnFn(spec.command, spec.args);
      this.child = child;
      trackChild(child, "mdns", spec.command, spec.args, false);
      child.unref?.();
      child.once("error", (error) => {
        if (this.child === child) this.child = undefined;
        this.options.log?.(`[mdns] ${spec.command} unavailable: ${error.message}`);
      });
      child.once("exit", () => {
        if (this.child === child) this.child = undefined;
      });
      return true;
    } catch (error) {
      this.options.log?.(`[mdns] failed to start advertisement: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
        finish();
      }, 400);
      killTimer.unref?.();
      child.once("exit", finish);
      child.once("error", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }
}
