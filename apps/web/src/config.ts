export type Source = "official" | "self-hosted";

declare global {
  interface Window {
    __LINKSHELL_CONFIG__?: {
      deployment?: Source;
      gatewayUrl?: string;
      previewOrigin?: string;
    };
  }
}

const settings = window.__LINKSHELL_CONFIG__;
export const deployment: Source =
  settings?.deployment === "self-hosted" ? "self-hosted" : "official";
export const officialGateway = "wss://gateway.itool.tech";
export const initialGateway =
  deployment === "self-hosted" ? (settings?.gatewayUrl ?? "") : officialGateway;

export function validateGateway(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的网关地址，例如 wss://gateway.example.com");
  }
  if (!["wss:", "ws:"].includes(url.protocol))
    throw new Error("网关地址需要以 wss:// 开头");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("网关地址不能包含账号、密码、查询参数或片段");
  if (url.pathname !== "/" && url.pathname !== "/v2/connect")
    throw new Error("请输入网关根地址，不需要附加路径");
  if (
    url.protocol === "ws:" &&
    (window.location.protocol === "https:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("请使用 wss:// 安全连接；ws:// 仅限本地 HTTP 开发环境");
  }
  return url.origin;
}
