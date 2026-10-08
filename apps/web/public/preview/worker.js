/* global clients */
const sessions = new Map();
const owners = new Map();
self.addEventListener("install", () => {
  void self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});
self.addEventListener("message", (event) => {
  if (
    event.data?.type === "dispose" &&
    sessions.get(event.data.token)?.owner === event.source?.id
  ) {
    sessions.delete(event.data.token);
    for (const [owner, token] of owners)
      if (token === event.data.token) owners.delete(owner);
  }
  if (
    event.data?.type === "init" &&
    event.source &&
    new URL(event.source.url).pathname === "/preview/bridge.html"
  ) {
    sessions.set(event.data.token, {
      owner: event.source.id,
      bootstrap: event.data.bootstrap,
    });
    event.ports[0].postMessage({ ready: true });
  }
});
function navigationBootstrap(prefix) {
  const rewrite = (value) => {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith(prefix))
      return url.href;
    return prefix + url.pathname.replace(/^\//, "") + url.search + url.hash;
  };
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target.closest?.("a[href]");
      if (anchor) anchor.href = rewrite(anchor.href);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (event.target.action)
        event.target.action = rewrite(event.target.action);
    },
    true,
  );
  for (const key of ["pushState", "replaceState"]) {
    const original = history[key].bind(history);
    history[key] = (state, title, url) =>
      original(state, title, url == null ? url : rewrite(url));
  }
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const match = /^\/preview\/view\/([\w-]+)\/(.*)$/.exec(url.pathname);
  const token = match?.[1] ?? owners.get(event.clientId);
  const session = sessions.get(token);
  if (!session) return;
  if (event.resultingClientId) owners.set(event.resultingClientId, token);
  event.respondWith(
    (async () => {
      const client = await clients.get(session.owner);
      if (!client)
        return new Response("工作台已关闭，请重新打开预览", { status: 503 });
      const id = crypto.randomUUID();
      const wire = new MessageChannel();
      let controller;
      let finished = false;
      let rejectHead;
      let timer;
      const stop = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          rejectHead?.(error);
          controller.error(error);
        } else controller.close();
        wire.port1.close();
      };
      const stream = new ReadableStream({
        start(value) {
          controller = value;
        },
        cancel() {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          wire.port1.postMessage({ cancel: true });
          wire.port1.close();
        },
      });
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          wire.port1.postMessage({ cancel: true });
          stop(new Error("预览请求超时"));
        }, 65000);
      };
      const result = new Promise((resolve, reject) => {
        rejectHead = reject;
        wire.port1.onmessage = (event) => {
          if (finished) return;
          touch();
          const message = event.data;
          if (message.type === "http-head") resolve(message);
          else if (message.type === "http-chunk")
            controller.enqueue(new Uint8Array(message.body));
          else if (message.type === "http-end") stop();
          else if (message.type === "http-error")
            stop(new Error(message.error));
        };
        touch();
      });
      const body = ["GET", "HEAD"].includes(event.request.method)
        ? undefined
        : await event.request.arrayBuffer();
      client.postMessage(
        {
          token,
          id,
          path: (match ? "/" + match[2] : url.pathname) + url.search,
          method: event.request.method,
          headers: [...event.request.headers],
          body,
        },
        [wire.port2],
      );
      try {
        const response = await result;
        if (response.error)
          return new Response(response.error, { status: 502 });
        const headers = new Headers(response.headers);
        for (const name of [
          "content-length",
          "transfer-encoding",
          "content-encoding",
          "content-security-policy",
          "content-security-policy-report-only",
          "x-frame-options",
          "set-cookie",
        ])
          headers.delete(name);
        const prefix = `/preview/view/${token}/`;
        const redirect = headers.get("location");
        if (redirect) {
          const target = new URL(redirect, "http://localhost");
          if (
            target.hostname === "localhost" ||
            target.hostname === "127.0.0.1"
          )
            headers.set(
              "location",
              prefix +
                target.pathname.replace(/^\//, "") +
                target.search +
                target.hash,
            );
        }
        let output = stream;
        if (headers.get("content-type")?.includes("text/html")) {
          const script = `<script>(${session.bootstrap})(${JSON.stringify(token)});(${navigationBootstrap.toString()})(${JSON.stringify(prefix)});<\/script>`;
          const text = await new Response(stream).text();
          output = new TextEncoder().encode(
            /<head(?:\s[^>]*)?>/i.test(text)
              ? text.replace(/<head(?:\s[^>]*)?>/i, "$&" + script)
              : script + text,
          );
        }
        return new Response(
          [204, 205, 304].includes(response.status) ||
            event.request.method === "HEAD"
            ? null
            : output,
          { status: response.status, headers },
        );
      } catch (error) {
        return new Response(String(error), { status: 502 });
      }
    })(),
  );
});
