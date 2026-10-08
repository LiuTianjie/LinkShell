// This shell must be served on a different origin from the account UI.
const channel = location.hash.slice(1);
const page = document.getElementById("page");
const note = document.getElementById("note");
const requests = new Map();
let parentOrigin;
let worker;
window.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.channel !== channel) return;
  if (
    event.source === parent &&
    message.type === "preview-init" &&
    !parentOrigin
  ) {
    if (event.origin === location.origin) {
      note.textContent = "预览必须与账号页面使用不同来源";
      return;
    }
    parentOrigin = event.origin;
    try {
      const registration = await navigator.serviceWorker.register(
        "/preview/worker.js?v=2",
        { scope: "/preview/" },
      );
      const next =
        registration.installing ?? registration.waiting ?? registration.active;
      if (next && next.state !== "activated")
        await new Promise((resolve, reject) => {
          const changed = () => {
            if (next.state === "activated" || next.state === "redundant") {
              next.removeEventListener("statechange", changed);
              next.state === "activated"
                ? resolve()
                : reject(new Error("预览服务更新失败"));
            }
          };
          next.addEventListener("statechange", changed);
          changed();
        });
      await navigator.serviceWorker.ready;
      worker = registration.active;
      const ready = new MessageChannel();
      ready.port1.onmessage = () => {
        page.src = `/preview/view/${channel}/`;
        page.style.display = "block";
        note.remove();
      };
      worker.postMessage(
        { type: "init", token: channel, bootstrap: message.bootstrap },
        [ready.port2],
      );
    } catch (error) {
      note.textContent = String(error);
    }
  } else if (event.source === parent && event.origin === parentOrigin) {
    if (/^http-/.test(message.type)) {
      requests.get(message.id)?.postMessage(message);
      if (["http-end", "http-error"].includes(message.type)) {
        requests.get(message.id)?.close();
        requests.delete(message.id);
      }
    } else page.contentWindow.postMessage(message, location.origin);
  } else if (
    event.source === page.contentWindow &&
    event.origin === location.origin &&
    parentOrigin &&
    /^ws-/.test(message.type)
  ) {
    parent.postMessage(message, parentOrigin);
  }
});
navigator.serviceWorker.addEventListener("message", (event) => {
  if (event.data?.token !== channel || !parentOrigin || event.source !== worker)
    return;
  requests.set(event.data.id, event.ports[0]);
  event.ports[0].onmessage = (message) => {
    if (message.data?.cancel) {
      parent.postMessage(
        { channel, type: "http-cancel", id: event.data.id },
        parentOrigin,
      );
      event.ports[0].close();
      requests.delete(event.data.id);
    }
  };
  parent.postMessage(
    { ...event.data, channel, type: "http-request" },
    parentOrigin,
  );
});
parent.postMessage({ channel, type: "preview-ready" }, "*");

window.addEventListener("pagehide", () => {
  for (const [id, port] of requests) {
    parent.postMessage({ channel, type: "http-cancel", id }, parentOrigin);
    port.close();
  }
  requests.clear();
  worker?.postMessage({ type: "dispose", token: channel });
});
