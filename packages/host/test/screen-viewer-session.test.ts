import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { viewerPage } from "../src/screen-viewer.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The VM boundary carries browser objects, callbacks and untyped wire payloads from the shipped script.
type Message = Record<string, any>;
type Listener = (event: Message) => void;

class Events {
  private listeners = new Map<string, Listener[]>();
  addEventListener(name: string, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, values: Message = {}) {
    const event = { preventDefault() {}, stopPropagation() {}, pointerId: 1, clientX: 500, clientY: 350, pointerType: "mouse", button: 0, ...values };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

/** Run the complete shipped script; only browser facilities are replaced, never viewer functions. */
function viewer({ framed = false, native = false, relayFallback = false, platform = "darwin" }: { framed?: boolean; native?: boolean; relayFallback?: boolean; platform?: NodeJS.Platform } = {}) {
  const page = viewerPage(platform);
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; action: () => void; interval?: number }>();
  const frames = new Map<number, (time: number) => void>();
  const timer = (action: () => void, delay = 0, interval?: number) => {
    const id = ++serial;
    timers.set(id, { at: now + Math.max(1, delay), action, interval });
    return id;
  };
  const elements = new Map<string, Element>();
  class Element extends Events {
    id = "";
    dataset: Record<string, string> = {};
    children: Element[] = [];
    textContent = "";
    innerHTML = "";
    value = "";
    width = 0;
    height = 0;
    scrollTop = 0;
    scrollLeft = 0;
    scrollHeight = 66;
    videoWidth = 0;
    videoHeight = 0;
    readyState = 2;
    srcObject: unknown = null;
    selectionStart = 0;
    selectionEnd = 0;
    private classes = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This VM stand-in accepts dynamic CSS properties and the callable setProperty API.
    style: Record<string, any> = { setProperty() {} };
    classList = {
      add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
    };
    constructor(readonly tagName: string) { super(); }
    set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(" "); }
    get offsetWidth() { return this.id === "stage" ? 1000 : this.id === "bar" ? 146 : parseFloat(this.style.width) || 44; }
    get offsetHeight() { return this.id === "stage" ? 700 : this.id === "bar" ? 52 : parseFloat(this.style.height) || 44; }
    setAttribute(name: string, value: string) {
      if (name === "id") { this.id = value; elements.set(value, this); }
      else if (name === "class") this.className = value;
      else if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
    }
    append(...children: Element[]) { this.children.push(...children); }
    appendChild(child: Element) { this.append(child); return child; }
    querySelectorAll(selector: string): Element[] {
      const matches = (child: Element) => selector.startsWith("#") ? child.id === selector.slice(1) : selector.startsWith(".") ? child.classList.contains(selector.slice(1)) : child.tagName === selector;
      return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() {
      const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
      return { left, top, width: this.offsetWidth, height: this.offsetHeight, right: left + this.offsetWidth, bottom: top + this.offsetHeight };
    }
    focus() {
      if (document.activeElement === this) return;
      document.activeElement?.blur();
      document.activeElement = this;
      this.emit("focus");
    }
    blur() {
      if (document.activeElement !== this) return;
      document.activeElement = null;
      this.emit("blur");
    }
    setPointerCapture() {}
    releasePointerCapture() {}
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
    getContext() { return { drawImage() {}, clearRect() {} }; }
    play() { return Promise.resolve(); }
    pause() {}
    insertAdjacentHTML(_position: string, html: string) { this.innerHTML += html; }
  }
  const root = new Element("html"), body = new Element("body");
  root.append(body);
  const stack = [body];
  const bodyTag = /<body\b([^>]*)>/.exec(page)!;
  for (const attr of bodyTag[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) body.setAttribute(attr[1]!, attr[2]!);
  const bodyMarkup = page.slice(bodyTag.index + bodyTag[0].length, page.indexOf('<script type="application/json"'));
  for (const token of bodyMarkup.matchAll(/<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (token[3]) { stack.at(-1)!.textContent += token[3]; continue; }
    if (token[0].startsWith("</")) { stack.pop(); continue; }
    const element = new Element(token[1]!);
    for (const attr of token[2]!.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attr[1]!, attr[2]!);
    stack.at(-1)!.append(element);
    if (!["input", "br", "img", "hr"].includes(element.tagName)) stack.push(element);
  }
  const icons = new Element("script");
  icons.setAttribute("id", "icons");
  icons.textContent = /<script type="application\/json" id="icons">([\s\S]*?)<\/script>/.exec(page)![1]!;
  const document = Object.assign(new Events(), {
    URL: framed ? "about:srcdoc" : "http://viewer.test/screen?video=1&mode=touch",
    hidden: false,
    activeElement: null as Element | null,
    fullscreenElement: null,
    fullscreenEnabled: false,
    documentElement: root,
    body,
    getElementById: (id: string) => {
      const found = elements.get(id);
      if (!found) throw new Error("Missing viewer element: " + id);
      return found;
    },
    createElement: (name: string) => new Element(name),
    hasFocus: () => true,
  });
  const sockets: Socket[] = [], pcs: Peer[] = [], nativeMessages: Message[] = [], reports: Message[] = [], reloads: unknown[] = [];
  class Socket extends Events {
    readyState = 0;
    messages: Message[] = [];
    closeCount = 0;
    onopen?: () => void;
    onmessage?: Listener;
    onclose?: () => void;
    constructor(readonly url: string) { super(); sockets.push(this); }
    send(data: string) { this.messages.push(JSON.parse(data)); }
    close() { this.closeCount++; this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); this.emit("open"); }
    receive(message: Message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  class Channel {
    readyState = "open";
    messages: Message[] = [];
    constructor(readonly label: string) {}
    send(data: string) { this.messages.push(JSON.parse(data)); }
  }
  class Peer {
    closeCount = 0;
    answers = 0;
    offers: Message[] = [];
    localDescription: Message | null = null;
    connectionState = "new";
    iceConnectionState = "new";
    channels = ["input", "pointer", "cursor", "shape"].map((label) => new Channel(label));
    ondatachannel?: Listener;
    ontrack?: Listener;
    onconnectionstatechange?: () => void;
    constructor() { pcs.push(this); }
    setRemoteDescription(description: Message) { this.offers.push(description); return Promise.resolve(); }
    createAnswer() { this.answers++; return Promise.resolve({ type: "answer", sdp: "answer" }); }
    setLocalDescription(description: Message) { this.localDescription = description; return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    getStats() { return Promise.resolve(new Map()); }
    close() { this.closeCount++; }
    connect() {
      this.connectionState = this.iceConnectionState = "connected";
      this.onconnectionstatechange?.();
      this.channels.forEach((channel) => this.ondatachannel?.({ channel }));
    }
  }
  const location = { search: "?video=1&mode=touch&display=0&width=1920&maxFps=120", protocol: "http:", host: "viewer.test", pathname: "/screen", replace: (url: string) => reloads.push(url) };
  const storage = new Map<string, string>();
  const globals = Object.assign(new Events(), {
    document, location, URLSearchParams, URL, navigator: { userAgent: "test" },
    innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1,
    performance: { now: () => now, timeOrigin: 0 },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    matchMedia: (query: string) => Object.assign(new Events(), { matches: query.includes("reduced-motion") }),
    setTimeout: (action: () => void, delay?: number) => timer(action, delay),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (action: () => void, delay: number) => timer(action, delay, delay),
    clearInterval: (id: number) => timers.delete(id),
    requestAnimationFrame: (action: (time: number) => void) => { const id = ++serial; frames.set(id, action); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    WebSocket: Socket, RTCPeerConnection: Peer,
    MediaStream: class { constructor(readonly tracks: unknown[]) {} },
    ReactNativeWebView: { postMessage: (data: string) => reports.push(JSON.parse(data)) },
    __linkshellChrome: { video: true, nativePicture: native, relayFallback },
    ...(framed ? { __linkshellReload: (state: Message) => reloads.push(state) } : {}),
    ...(native ? { webkit: { messageHandlers: { linkshellScreen: { postMessage: (message: Message) => nativeMessages.push(message) } } } } : {}),
  });
  const sandbox: Message = Object.assign(globals, { window: globals });
  sandbox.addEventListener = globals.addEventListener.bind(globals);
  new Script(/<script>([\s\S]*)<\/script>/.exec(page)![1]!).runInNewContext(sandbox);
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const receive = (message: Message) => native ? sandbox.linkshellNative.message(message) : sockets[0]!.receive(message);
  const messages = () => native ? nativeMessages.filter((message) => message.kind === "signal").map((message) => message.message) : sockets[0]!.messages;
  const configure = () => messages().filter((message) => message.t === "screen.configure");
  const input = () => native
    ? nativeMessages.filter((message) => message.kind === "input").map((message) => message.message)
    : [...messages(), ...pcs.flatMap((pc) => pc.channels.flatMap((channel) => channel.messages))].filter((message) => ["move", "down", "up", "key", "text", "scroll"].includes(message.t));
  return {
    sockets, pcs, elements, document, reports, reloads, nativeMessages, messages, configure, input, settle, receive,
    session: (state: Message) => sandbox.linkshellSession(state),
    capabilities: () => receive({ session: { t: "capabilities", version: 1, configure: true, pause: true, retainMs: 120000 } }),
    ack: (request: Message, generation = request.requestId, extra: Message = {}) => receive({ session: { ...request, t: "configured", width: Number(request.width) || 3840, height: 1080, generation, ...extra } }),
    key() { elements.get("typing")!.emit("keydown", { key: "Enter" }); },
    pointer(name: string, values: Message = {}) { elements.get("stage")!.emit(name, values); },
    async advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        for (const [id, due] of [...timers]) if (due.at <= now && timers.has(id)) {
          if (due.interval) due.at = now + due.interval; else timers.delete(id);
          due.action();
        }
        for (const [id, action] of [...frames]) if (frames.delete(id)) action(now);
      }
      await settle();
    },
    async ready() {
      if (!native) sockets[0]!.open();
      receive({ session: { t: "capabilities", version: 1, configure: true, pause: true, retainMs: 120000 } });
      await settle();
      this.ack(configure().at(-1)!);
      receive({ control: { available: true, trusted: true } });
      if (!native) {
        receive({ rtc: { t: "config", iceServers: [] } });
        receive({ rtc: { t: "offer", sdp: "offer" } });
        await settle();
        pcs[0]!.connect();
        const video = elements.get("video")!;
        pcs[0]!.ontrack?.({ receiver: {}, track: {}, streams: [{ id: "original-stream" }] });
        video.videoWidth = 1920; video.videoHeight = 1080;
        video.emit("resize");
        video.emit("playing");
        await settle();
      } else sandbox.linkshellNative.picture({ width: 1920, height: 1080 });
    },
  };
}

describe("the running viewer screen session", () => {
  it.each([false, true])("keeps initial loading until media arrives, after configuration acknowledgement (native=%s)", async (native) => {
    const ui = viewer({ native });
    if (!native) ui.sockets[0]!.open();
    ui.capabilities(); await ui.settle();
    ui.ack(ui.configure().at(-1)!);
    expect(ui.elements.get("note")!.dataset.state).toBe("receiving");
    expect(ui.elements.get("note")!.classList.contains("gone")).toBe(false);
  });

  it("keeps a retained paused screen out of loading, even when the video reports a late frame", async () => {
    const ui = viewer(); await ui.ready();
    ui.session({ active: false }); await ui.settle();
    ui.ack(ui.configure().at(-1)!);
    ui.elements.get("video")!.emit("timeupdate");
    await ui.advance(15000);
    expect(ui.elements.get("note")!.dataset.state).toBe("paused");
    expect(ui.elements.get("screen-loading-retry")!.classList.contains("gone")).toBe(true);
    ui.session({ active: true }); await ui.settle(); ui.ack(ui.configure().at(-1)!);
    expect(ui.elements.get("note")!.classList.contains("gone")).toBe(true);
  });

  it("shows a disconnection error while waiting for configuration instead of continuing to load", async () => {
    const ui = viewer();
    ui.sockets[0]!.open();
    ui.capabilities(); await ui.settle();
    expect(ui.elements.get("note")!.dataset.state).toBe("adjusting");
    ui.sockets[0]!.close();
    await ui.advance(15000);
    expect(ui.elements.get("note")!.dataset.state).toBe("error");
    expect(ui.elements.get("screen-loading-detail")!.textContent).toContain("屏幕连接已断开");
    expect(ui.elements.get("screen-loading-retry")!.classList.contains("gone")).toBe(false);
  });

  it("asks the embedding client to retry a screen without changing its preferences", async () => {
    const ui = viewer({ framed: true });
    await ui.advance(12000);
    ui.elements.get("screen-loading-retry")!.emit("click");
    expect(ui.reloads).toEqual([{}]);
  });

  it("allows Windows JPEG fallback in a browser without VideoDecoder", async () => {
    const ui = viewer({ platform: "win32" }); await ui.ready();
    ui.receive({ rtc: { t: "off" } });
    expect(ui.elements.get("screen-loading-detail")!.textContent).not.toContain("不支持视频解码");
    expect(ui.pcs[0]!.closeCount).toBe(1);
  });

  it("changes capture configuration and returns from pause on the same socket, PC and channels", async () => {
    const ui = viewer();
    await ui.ready();
    const pc = ui.pcs[0]!, channels = [...pc.channels], stream = ui.elements.get("video")!.srcObject;
    ui.session({ display: 1, width: 2560, maxFps: 60 });
    ui.session({ width: "native", maxFps: 30 });
    await ui.settle();
    expect(ui.configure().at(-1)).toMatchObject({ display: 1, width: "native", maxFps: 30, paused: false });
    expect(ui.configure()).toHaveLength(2);
    ui.ack(ui.configure().at(-1)!);
    ui.session({ active: false }); await ui.settle(); ui.ack(ui.configure().at(-1)!);
    ui.session({ active: true }); await ui.settle(); ui.ack(ui.configure().at(-1)!);
    expect(ui.pcs).toEqual([pc]);
    expect(pc.channels).toEqual(channels);
    channels.forEach((channel, index) => expect(pc.channels[index]).toBe(channel));
    expect(ui.elements.get("video")!.srcObject).toBe(stream);
    expect(ui.sockets).toHaveLength(1);
    expect(pc.closeCount).toBe(0);
    expect(pc.answers).toBe(1);
    expect(pc.offers).toHaveLength(1);
    expect(ui.messages().filter((message) => message.t === "rtc.answer")).toHaveLength(1);
    expect(ui.reloads).toEqual([]);
  });

  it("queues the latest desired state before open and before capabilities", async () => {
    const ui = viewer();
    ui.session({ display: 1, width: "1280" });
    ui.session({ display: 2, width: "2560", maxFps: 30 });
    await ui.settle();
    expect(ui.configure()).toEqual([]);
    ui.sockets[0]!.open(); await ui.settle();
    expect(ui.configure()).toEqual([]);
    ui.capabilities(); await ui.settle();
    expect(ui.configure()).toHaveLength(1);
    expect(ui.configure()[0]).toMatchObject({ display: 2, width: "2560", maxFps: 30, paused: false });
    expect(ui.reloads).toEqual([]);
  });

  it.each(["route", "display", "visibility"])("reapplies the final state after a same-tick %s round trip", async (kind) => {
    const ui = viewer(); await ui.ready();
    const before = ui.input().length;
    if (kind === "route") { ui.session({ active: false }); ui.session({ active: true }); }
    else if (kind === "display") { ui.session({ display: 1 }); ui.session({ display: 0 }); }
    else {
      ui.document.hidden = true; ui.document.emit("visibilitychange");
      ui.document.hidden = false; ui.document.emit("visibilitychange");
    }
    ui.key(); expect(ui.input()).toHaveLength(before);
    await ui.settle();
    expect(ui.configure()).toHaveLength(2);
    const latest = ui.configure().at(-1)!;
    expect(latest).toMatchObject({ display: 0, width: "1920", paused: false });
    ui.ack(latest, 50); ui.key();
    expect(ui.input().at(-1)).toMatchObject({ screenGeneration: 50 });
    expect(ui.pcs).toHaveLength(1);
    expect(ui.pcs[0]!.closeCount).toBe(0);
  });

  it("rejects a pending acknowledgement after the desired state leaves and returns to its target", async () => {
    const ui = viewer(); await ui.ready();
    ui.session({ display: 1 }); await ui.settle();
    const obsolete = ui.configure().at(-1)!;
    ui.session({ display: 2 }); ui.session({ display: 1 });
    const before = ui.input().length;
    ui.ack(obsolete, 60); ui.key();
    expect(ui.input()).toHaveLength(before);
    await ui.settle();
    const latest = ui.configure().at(-1)!;
    expect(latest.requestId).toBeGreaterThan(obsolete.requestId);
    ui.ack(obsolete, 60); ui.key();
    expect(ui.input()).toHaveLength(before);
    ui.ack(latest, 61); ui.key();
    expect(ui.input().at(-1)).toMatchObject({ screenGeneration: 61 });
  });

  it("changes width from the rendered button without replacing the viewer", async () => {
    const ui = viewer({ framed: true }); await ui.ready();
    const tile = ui.elements.get("widths")!.querySelectorAll(".tile").find((element) => element.dataset.width === "2560")!;
    tile.emit("pointerdown"); tile.emit("pointerup"); await ui.settle();
    expect(ui.configure().at(-1)).toMatchObject({ width: "2560", paused: false });
    expect(tile.classList.contains("on")).toBe(true);
    expect(ui.reloads).toEqual([]);
    expect(ui.pcs).toHaveLength(1);
    expect(ui.pcs[0]!.closeCount).toBe(0);
    expect(ui.reports).toContainEqual({ type: "width", width: "2560" });
  });

  it("only restores input for the latest acknowledged state and valid generation", async () => {
    const ui = viewer();
    await ui.ready();
    ui.session({ display: 1 }); await ui.settle();
    const first = ui.configure().at(-1)!;
    ui.session({ display: 2 });
    // A reply may arrive before the deferred send for the new desired state.
    const preflush = ui.input().length;
    ui.ack(first, 11); ui.key();
    expect(ui.input()).toHaveLength(preflush);
    await ui.settle();
    const last = ui.configure().at(-1)!;
    const before = ui.input().length;
    ui.ack(first, 11); ui.key();
    ui.receive({ session: { t: "error", requestId: first.requestId, message: "旧错误" } });
    ui.ack(last, -1); ui.key();
    ui.ack(last, 12, { display: 1 }); ui.key();
    expect(ui.input()).toHaveLength(before);
    expect(ui.elements.get("screen-loading-detail")!.textContent).not.toContain("旧错误");
    ui.ack(last, 12); ui.key();
    expect(ui.input().at(-1)).toMatchObject({ t: "key", k: "return", screenGeneration: 12 });
    expect(ui.messages().filter((message) => message.t === "control").at(-1)).toMatchObject({ screenGeneration: 12 });
    expect(ui.pcs[0]!.closeCount).toBe(0);
  });

  it("keeps a failed configuration visible and input stopped until an explicit retry succeeds", async () => {
    const ui = viewer(); await ui.ready();
    ui.session({ width: "2560" }); await ui.settle();
    const failed = ui.configure().at(-1)!;
    ui.receive({ session: { t: "error", requestId: failed.requestId, message: "显示器暂时不可用" } });
    const before = ui.input().length;
    ui.key();
    ui.elements.get("video")!.emit("resize");
    ui.elements.get("video")!.emit("playing");
    ui.pcs[0]!.connect();
    expect(ui.input()).toHaveLength(before);
    expect(ui.elements.get("screen-loading-detail")!.textContent).toBe("显示器暂时不可用");
    expect(ui.pcs[0]!.closeCount).toBe(0);
    ui.session({ width: "2560" }); await ui.settle();
    const retry = ui.configure().at(-1)!;
    expect(retry.requestId).toBeGreaterThan(failed.requestId);
    ui.ack(retry, 30); ui.key();
    expect(ui.input().at(-1)).toMatchObject({ screenGeneration: 30 });
    expect(ui.elements.get("note")!.classList.contains("gone")).toBe(true);
  });

  it("lays out the actual decoded size on the retained video after changing display", async () => {
    const ui = viewer(); await ui.ready();
    const video = ui.elements.get("video")!, stream = video.srcObject;
    ui.session({ display: 1 }); await ui.settle();
    ui.ack(ui.configure().at(-1)!, 40, { width: 1200, height: 1920 });
    // Capture acknowledgement does not pretend the decoder already has the new frame.
    expect(video.style.width).toBe("1000px");
    video.videoWidth = 1200; video.videoHeight = 1920; video.emit("resize");
    expect(video.style.width).toBe("438px");
    expect(video.style.height).toBe("700px");
    expect(video.srcObject).toBe(stream);
    ui.pointer("pointerdown", { clientX: 500, clientY: 350 });
    expect(ui.input().findLast((message) => message.t === "move")).toMatchObject({ x: 0.5, y: 0.5, screenGeneration: 40 });
  });

  it("clears held and deferred input when paused and does not revive it after resume", async () => {
    const ui = viewer();
    await ui.ready();
    ui.pointer("pointerdown");
    ui.pointer("pointermove", { clientX: 510 });
    expect(ui.document.activeElement).toBe(ui.elements.get("typing"));
    ui.session({ active: false }); await ui.settle();
    const pause = ui.configure().at(-1)!;
    const stopped = ui.input().length;
    ui.key(); ui.pointer("pointerup");
    ui.elements.get("typing")!.emit("compositionend", { data: "晚到的文字" });
    await ui.advance(1000);
    expect(ui.input()).toHaveLength(stopped);
    expect(ui.document.activeElement).toBeNull();
    ui.session({ display: 1, width: "1280" }); await ui.settle();
    expect(ui.configure().at(-1)).toMatchObject({ display: 1, width: "1280", paused: true });
    ui.ack(pause); ui.key();
    ui.session({ active: true }); await ui.settle();
    const resume = ui.configure().at(-1)!;
    ui.key(); expect(ui.input()).toHaveLength(stopped);
    ui.ack(resume, 20);
    ui.pointer("pointerup");
    expect(ui.input()).toHaveLength(stopped);
    ui.key();
    expect(ui.input().at(-1)).toMatchObject({ t: "key", screenGeneration: 20 });
  });

  it("cancels a pending long press while the retained surface is inactive", async () => {
    const ui = viewer(); await ui.ready();
    ui.pointer("pointerdown", { pointerType: "touch" });
    ui.session({ active: false }); await ui.settle();
    const before = ui.input().length;
    await ui.advance(8000);
    expect(ui.input()).toHaveLength(before);
    expect(ui.pcs[0]!.closeCount).toBe(0);
    ui.document.hidden = true; ui.document.emit("visibilitychange");
    ui.session({ active: true }); await ui.settle();
    expect(ui.configure().at(-1)).toMatchObject({ paused: true });
  });

  it("does not mistake a paused capture for failure before the first frame", async () => {
    const ui = viewer();
    ui.sockets[0]!.open(); ui.capabilities(); await ui.settle();
    ui.ack(ui.configure().at(-1)!);
    ui.receive({ rtc: { t: "config", iceServers: [] } });
    ui.receive({ rtc: { t: "offer", sdp: "offer" } }); await ui.settle();
    ui.pcs[0]!.connect();
    ui.session({ active: false }); await ui.settle();
    ui.ack(ui.configure().at(-1)!);
    expect(ui.document.hidden).toBe(false);
    await ui.advance(8000);
    expect(ui.pcs[0]!.closeCount).toBe(0);
    expect(ui.messages().some((message) => message.t === "rtc.failed")).toBe(false);
  });

  it.each([false, true])("reloads a legacy host only after capability discovery (srcdoc=%s)", async (framed) => {
    const ui = viewer({ framed });
    ui.sockets[0]!.open();
    ui.session({ display: 2, width: "1280", maxFps: 30 }); await ui.settle();
    expect(ui.reloads).toEqual([]);
    await ui.advance(10000);
    expect(ui.configure()).toEqual([]);
    expect(ui.reloads).toHaveLength(1);
    if (framed) expect(ui.reloads[0]).toEqual({ display: 2, width: "1280", maxFps: 30, mode: "touch" });
    else {
      const url = new URL(ui.reloads[0] as string, "http://viewer.test");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ display: "2", width: "1280", maxFps: "30", mode: "touch" });
    }
  });

  it("uses the same configuration and input gate over the native controls bridge", async () => {
    const ui = viewer({ native: true }); await ui.ready();
    ui.key();
    expect(ui.input().at(-1)).toMatchObject({ t: "key", screenGeneration: 1 });
    ui.session({ active: false }); await ui.settle();
    const before = ui.input().length;
    ui.key();
    expect(ui.input()).toHaveLength(before);
    expect(ui.configure().at(-1)).toMatchObject({ paused: true });
    expect(ui.reports.some((message) => message.type === "screenSession" && message.session.t === "capabilities")).toBe(true);
    expect(ui.sockets).toEqual([]);
    expect(ui.pcs).toEqual([]);
  });

  it("reports a retained socket closing once so the outer app can discard the closed surface", async () => {
    const ui = viewer(); await ui.ready();
    ui.session({ active: false }); await ui.settle(); ui.ack(ui.configure().at(-1)!);
    ui.sockets[0]!.close(); ui.sockets[0]!.close();
    expect(ui.reports.filter((message) => message.type === "screenClosed")).toEqual([{ type: "screenClosed" }]);
    expect(ui.pcs[0]!.closeCount).toBe(1);
    const requests = ui.configure().length, inputs = ui.input().length;
    ui.session({ active: true }); ui.key(); await ui.settle();
    expect(ui.configure()).toHaveLength(requests);
    expect(ui.input()).toHaveLength(inputs);
  });

  it("does not report screenClosed in addition to an owned relay fallback", async () => {
    const ui = viewer({ relayFallback: true }); await ui.ready();
    ui.sockets[0]!.close(); ui.sockets[0]!.close();
    expect(ui.reports.filter((message) => message.type === "screenFallback")).toHaveLength(1);
    expect(ui.reports.filter((message) => message.type === "screenClosed")).toEqual([]);
    expect(ui.pcs[0]!.closeCount).toBe(1);
  });
});
