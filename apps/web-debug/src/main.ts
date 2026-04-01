import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  createEnvelope,
  parseEnvelope,
  parseTypedPayload,
  serializeEnvelope,
} from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";

// ── DOM refs ────────────────────────────────────────────────────────

const $gateway = document.getElementById("gateway-url") as HTMLInputElement;
const $pairingCode = document.getElementById("pairing-code") as HTMLInputElement;
const $sessionId = document.getElementById("session-id") as HTMLInputElement;
const $btnClaim = document.getElementById("btn-claim") as HTMLButtonElement;
const $btnConnect = document.getElementById("btn-connect") as HTMLButtonElement;
const $btnDisconnect = document.getElementById("btn-disconnect") as HTMLButtonElement;
const $statusBadge = document.getElementById("status-badge") as HTMLSpanElement;
const $termContainer = document.getElementById("terminal-container") as HTMLDivElement;
const $dbgSession = document.getElementById("dbg-session") as HTMLSpanElement;
const $dbgSeq = document.getElementById("dbg-seq") as HTMLSpanElement;
const $dbgAck = document.getElementById("dbg-ack") as HTMLSpanElement;
const $dbgController = document.getElementById("dbg-controller") as HTMLSpanElement;
const $dbgLatency = document.getElementById("dbg-latency") as HTMLSpanElement;
const $dbgMessages = document.getElementById("dbg-messages") as HTMLSpanElement;

// ── State ───────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let sessionId = "";
let lastAckedSeq = -1;
let highestSeq = -1;
let messageCount = 0;
let controllerId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const deviceId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_MAX = 15;

// ── Terminal ────────────────────────────────────────────────────────

const term = new Terminal({
  theme: {
    background: "#020617",
    foreground: "#e2e8f0",
    cursor: "#3b82f6",
    selectionBackground: "#334155",
  },
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open($termContainer);
fitAddon.fit();

window.addEventListener("resize", () => fitAddon.fit());

// Terminal input → WebSocket
term.onData((data) => {
  sendEnvelope("terminal.input", { data });
});

// Terminal resize → WebSocket
term.onResize(({ cols, rows }) => {
  sendEnvelope("terminal.resize", { cols, rows });
});

// ── UI helpers ──────────────────────────────────────────────────────

function setStatus(text: string, cls?: string) {
  $statusBadge.textContent = text;
  $statusBadge.className = cls ?? "";
}

function updateDebug() {
  $dbgSession.textContent = sessionId ? sessionId.slice(0, 12) + "..." : "—";
  $dbgSeq.textContent = highestSeq >= 0 ? String(highestSeq) : "—";
  $dbgAck.textContent = lastAckedSeq >= 0 ? String(lastAckedSeq) : "—";
  $dbgController.textContent = controllerId ? controllerId.slice(0, 8) + "..." : "—";
  $dbgMessages.textContent = String(messageCount);
}

function setConnected(connected: boolean) {
  $btnClaim.disabled = connected;
  $btnConnect.disabled = connected;
  $btnDisconnect.disabled = !connected;
  $gateway.disabled = connected;
  $pairingCode.disabled = connected;
}

// ── WebSocket ───────────────────────────────────────────────────────

function wsUrl(sid: string): string {
  const base = $gateway.value.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${base}/ws?sessionId=${encodeURIComponent(sid)}&role=client&deviceId=${deviceId}`;
}

function connect(sid: string, isReconnect = false) {
  sessionId = sid;
  $sessionId.value = sid;
  setStatus(isReconnect ? "reconnecting..." : "connecting...", "reconnecting");
  setConnected(true);

  socket = new WebSocket(wsUrl(sid));

  socket.onopen = () => {
    setStatus("connected", "connected");
    reconnectAttempts = 0;
    startHeartbeat();
    if (isReconnect) {
      sendEnvelope("session.resume", { lastAckedSeq });
    }
    // Fit terminal and send initial resize
    fitAddon.fit();
    updateDebug();
  };

  socket.onmessage = (event) => {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(String(event.data));
    } catch {
      return;
    }
    messageCount++;
    handleMessage(envelope);
    updateDebug();
  };

  socket.onclose = () => {
    stopHeartbeat();
    if (reconnectAttempts < RECONNECT_MAX && sessionId) {
      scheduleReconnect();
    } else {
      setStatus("disconnected");
      setConnected(false);
    }
  };

  socket.onerror = () => {};
}

function disconnect() {
  sessionId = "";
  reconnectAttempts = RECONNECT_MAX; // prevent auto-reconnect
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  socket?.close();
  socket = null;
  setStatus("disconnected");
  setConnected(false);
  updateDebug();
}

function scheduleReconnect() {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15_000);
  reconnectAttempts++;
  setStatus(`reconnecting (${reconnectAttempts})...`, "reconnecting");
  reconnectTimer = setTimeout(() => connect(sessionId, true), delay);
}

// ── Message handling ────────────────────────────────────────────────

function handleMessage(envelope: Envelope) {
  switch (envelope.type) {
    case "terminal.output": {
      const p = parseTypedPayload("terminal.output", envelope.payload);
      term.write(p.data);
      if (envelope.seq !== undefined) {
        highestSeq = Math.max(highestSeq, envelope.seq);
        lastAckedSeq = highestSeq;
        sendEnvelope("session.ack", { seq: lastAckedSeq });
      }
      break;
    }
    case "terminal.exit": {
      const p = parseTypedPayload("terminal.exit", envelope.payload);
      term.write(`\r\n\x1b[90m[session exited: code=${p.exitCode}]\x1b[0m\r\n`);
      setStatus("session exited", "error");
      break;
    }
    case "control.grant": {
      const p = parseTypedPayload("control.grant", envelope.payload);
      controllerId = p.deviceId;
      break;
    }
    case "control.reject": {
      term.write("\r\n\x1b[33m[control request rejected]\x1b[0m\r\n");
      break;
    }
    case "control.release": {
      const p = parseTypedPayload("control.release", envelope.payload);
      if (controllerId === p.deviceId) controllerId = null;
      break;
    }
    case "session.heartbeat": {
      const p = parseTypedPayload("session.heartbeat", envelope.payload);
      const latency = Date.now() - p.ts;
      $dbgLatency.textContent = latency + "ms";
      break;
    }
    case "session.connect":
    case "session.error":
      break;
  }
}

// ── Send helpers ────────────────────────────────────────────────────

function sendEnvelope(type: string, payload: unknown) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) return;
  socket.send(
    serializeEnvelope(
      createEnvelope({
        type: type as any,
        sessionId,
        deviceId,
        payload,
      }),
    ),
  );
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendEnvelope("session.heartbeat", { ts: Date.now() });
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── Button handlers ─────────────────────────────────────────────────

$btnClaim.addEventListener("click", async () => {
  const code = $pairingCode.value.trim();
  if (!code) return;
  setStatus("claiming...");
  try {
    const res = await fetch(`${$gateway.value}/pairings/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: code }),
    });
    const body = (await res.json()) as { sessionId?: string; error?: string };
    if (!res.ok || !body.sessionId) {
      setStatus(body.error ?? "claim failed", "error");
      return;
    }
    term.clear();
    highestSeq = -1;
    lastAckedSeq = -1;
    messageCount = 0;
    connect(body.sessionId);
  } catch (e) {
    setStatus("network error", "error");
  }
});

$btnConnect.addEventListener("click", () => {
  const sid = $sessionId.value.trim();
  if (!sid) return;
  term.clear();
  highestSeq = -1;
  lastAckedSeq = -1;
  messageCount = 0;
  connect(sid);
});

$btnDisconnect.addEventListener("click", disconnect);

// Allow Enter in pairing code field
$pairingCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $btnClaim.click();
});
$sessionId.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $btnConnect.click();
});

// ── Init ────────────────────────────────────────────────────────────

term.write("LinkShell Debug Terminal\r\n");
term.write("\x1b[90mEnter a pairing code or session ID to connect.\x1b[0m\r\n\r\n");
updateDebug();
