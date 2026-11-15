import { z } from "zod";

/**
 * Fusion's control protocol between the computer that shows remote windows (local) and the one
 * whose apps they are (remote). The spec is docs/v2/fusion.md; the Swift side has no schema
 * library, so both suites check the same fixtures in packages/wire/test/fixtures/fusion/.
 */
export const FUSION_PROTO = 2;
export const FUSION_PORT = 47391;
/** Not secret: names the pre-shared key so both ends agree on which one is in use. */
export const FUSION_PSK_IDENTITY = "linkshell-fusion-v1";
/** Domain separation: the token is also the `hello` credential, never the raw key. */
export const FUSION_PSK_LABEL = "linkshell-fusion-psk-v1";
export const FUSION_MAX_FRAME = 16 << 20;
/** Raw clipboard bytes; base64 grows them by 4/3 and the frame must still fit. */
export const FUSION_MAX_CLIPBOARD = 8 << 20;
/** How long the remote keeps an unexpectedly dropped session for `resume`. */
export const FUSION_RESUME_GRACE_MS = 30_000;

export const fusionPlatformSchema = z.enum(["macos", "windows"]);
export type FusionPlatform = z.infer<typeof fusionPlatformSchema>;

export const fusionFeatureSchema = z.enum(["menubar", "dockmenu", "clipboard", "virtual-displays", "keys"]);
export type FusionFeature = z.infer<typeof fusionFeatureSchema>;

const num = z.number().finite();
export const fusionRectSchema = z.object({ x: num, y: num, w: num, h: num });
export type FusionRect = z.infer<typeof fusionRectSchema>;

/** Opaque: a bundle id on macOS, an AppUserModelID on Windows. Receivers never parse it. */
const appId = z.string().min(1).max(512);
/** CGWindowID on macOS, the low 32 bits of the HWND on Windows. */
const windowId = z.number().int().min(0).max(0xffff_ffff);
const streamKey = z.string().regex(/^[wd]\d+$/);
const menuPath = z.array(z.number().int().min(0)).max(8);

export const fusionDisplaySchema = z.object({
  frame: fusionRectSchema,
  visible: fusionRectSchema,
  scale: z.number().positive().max(8),
  hz: z.number().positive().max(1000),
});

export const fusionChromeSchema = z.object({
  style: z.enum(["mac", "windows", "none"]),
  toolbar: z.boolean(),
  radius: z.number().min(0).max(64).optional(),
  buttons: z
    .object({ close: fusionRectSchema.optional(), minimize: fusionRectSchema.optional(), zoom: fusionRectSchema.optional() })
    .optional(),
  hitrects: z.array(fusionRectSchema).max(64).optional(),
});
export type FusionChrome = z.infer<typeof fusionChromeSchema>;

export const fusionAppSchema = z.object({
  app: appId,
  name: z.string(),
  category: z.string(),
  system: z.boolean(),
});

export const fusionByeReasonSchema = z.enum(["user", "stopped", "replaced", "proto", "token", "error"]);

const fusionMenuItemSchema = z.object({
  title: z.string(),
  sep: z.boolean().optional(),
  enabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  key: z.string().optional(),
  mods: z.number().int().optional(),
  sub: z.boolean().optional(),
});

const fusionDockItemSchema = z.object({
  title: z.string(),
  section: z.enum(["recent", "action"]),
  path: menuPath,
});

const fusionLayoutEntrySchema = z.object({
  id: windowId,
  app: z.string(),
  own: z.boolean(),
  layer: z.number().int(),
  title: z.string(),
  frame: fusionRectSchema,
  ack: z.number().int().min(0).optional(),
  parent: windowId.optional(),
  offset: z.object({ x: num, y: num }).optional(),
});

export const fusionRtcSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("config"),
    iceServers: z.array(
      z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() }),
    ),
  }),
  z.object({ t: z.literal("offer"), sdp: z.string() }),
  z.object({ t: z.literal("answer"), sdp: z.string() }),
  z.object({ t: z.literal("ice"), candidate: z.string(), sdpMid: z.string().nullable(), sdpMLineIndex: z.number().int() }),
  z.object({ t: z.literal("streams"), streams: z.array(z.object({ k: streamKey, mid: z.string() })) }),
  z.object({ t: z.literal("control"), available: z.boolean().optional(), trusted: z.boolean().optional() }),
  z.object({ t: z.literal("state"), connection: z.string() }),
  /** Local → remote: the peer connection failed while the control connection lives; make a new one. */
  z.object({ t: z.literal("restart") }),
]);

const clip = {
  text: z.string().optional(),
  rtf: z.string().optional(),
  png: z.string().optional(),
};

export const fusionMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    proto: z.number().int(),
    token: z.string().min(1),
    platform: fusionPlatformSchema,
    features: z.array(fusionFeatureSchema),
    displays: z.array(fusionDisplaySchema).min(1).max(16),
    /** The local computer's name, for the remote's menu bar item. */
    name: z.string().max(256).optional(),
    resume: z.string().optional(),
  }),
  z.object({
    t: z.literal("welcome"),
    proto: z.number().int(),
    platform: fusionPlatformSchema,
    features: z.array(fusionFeatureSchema),
    session: z.string().min(1),
    resumed: z.boolean(),
  }),
  z.object({ t: z.literal("bye"), reason: fusionByeReasonSchema, message: z.string().optional() }),
  z.object({ t: z.literal("ping"), ts: num }),
  z.object({ t: z.literal("pong"), ts: num }),
  z.object({ t: z.literal("displays"), displays: z.array(fusionDisplaySchema).min(1).max(16) }),
  z.object({ t: z.literal("apps"), apps: z.array(fusionAppSchema) }),
  z.object({ t: z.literal("ready"), displays: z.array(z.object({ index: z.number().int().min(0), frame: fusionRectSchema })) }),
  z.object({ t: z.literal("launch"), app: appId }),
  z.object({ t: z.literal("quit"), app: appId, force: z.boolean() }),
  z.object({ t: z.literal("app.exited"), app: appId }),
  z.object({ t: z.literal("app.hidden"), app: appId, on: z.boolean() }),
  z.object({ t: z.literal("app.active"), on: z.boolean() }),
  z.object({ t: z.literal("icon"), app: appId, png: z.string().optional() }),
  z.object({
    t: z.literal("wopen"),
    id: windowId,
    app: appId,
    title: z.string(),
    activate: z.boolean(),
    frame: fusionRectSchema,
    chrome: fusionChromeSchema,
    stream: streamKey,
  }),
  z.object({ t: z.literal("wclose"), id: windowId }),
  z.object({ t: z.literal("wstyle"), id: windowId, title: z.string().optional(), chrome: fusionChromeSchema }),
  z.object({ t: z.literal("layout"), windows: z.array(fusionLayoutEntrySchema) }),
  z.object({ t: z.literal("place"), id: windowId, seq: z.number().int().min(0), frame: fusionRectSchema, resize: z.boolean() }),
  z.object({ t: z.literal("wclose.req"), id: windowId }),
  z.object({ t: z.literal("focus"), id: windowId }),
  z.object({ t: z.literal("prewarm"), id: windowId }),
  z.object({ t: z.literal("fullscreen"), id: windowId, on: z.boolean() }),
  z.object({ t: z.literal("minimize"), id: windowId }),
  z.object({ t: z.literal("menu.fetch"), app: appId, path: menuPath }),
  z.object({ t: z.literal("menu.press"), app: appId, path: menuPath.min(2) }),
  z.object({
    t: z.literal("menu"),
    app: appId,
    path: menuPath,
    items: z.array(fusionMenuItemSchema).max(120).optional(),
    error: z.boolean().optional(),
  }),
  z.object({ t: z.literal("dockmenu"), app: appId, items: z.array(fusionDockItemSchema).max(16) }),
  z.object({ t: z.literal("dockmenu.press"), app: appId, path: menuPath }),
  z.object({ t: z.literal("clip"), ...clip }),
  z.object({
    t: z.literal("alert"),
    kind: z.string().min(1),
    subject: z.string().optional(),
    message: z.string().optional(),
    clear: z.literal(true).optional(),
  }),
  z.object({ t: z.literal("rtc"), m: fusionRtcSchema }),
]);
export type FusionMessage = z.infer<typeof fusionMessageSchema>;
export type FusionMessageType = FusionMessage["t"];

/** Which side may send each message; the other side rejects it. */
export const FUSION_DIRECTION: Record<FusionMessageType, "local" | "remote" | "both"> = {
  hello: "local",
  welcome: "remote",
  bye: "both",
  ping: "local",
  pong: "remote",
  displays: "local",
  apps: "remote",
  ready: "remote",
  launch: "local",
  quit: "local",
  "app.exited": "remote",
  "app.hidden": "remote",
  "app.active": "local",
  icon: "both",
  wopen: "remote",
  wclose: "remote",
  wstyle: "remote",
  layout: "remote",
  place: "local",
  "wclose.req": "local",
  focus: "local",
  prewarm: "local",
  fullscreen: "remote",
  minimize: "remote",
  "menu.fetch": "local",
  "menu.press": "local",
  menu: "remote",
  dockmenu: "remote",
  "dockmenu.press": "local",
  clip: "both",
  alert: "remote",
  rtc: "both",
};

/** What `fusion.start` returns: where the remote listens and what it speaks. */
export const fusionStartResultSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  hosts: z.array(z.string()),
  proto: z.number().int(),
  platform: fusionPlatformSchema,
});
export type FusionStartResult = z.infer<typeof fusionStartResultSchema>;
