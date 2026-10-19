import "./styles/theme.css";
import "./styles/base.css";
import "./styles/common.css";
import "./styles/shell.css";
import "./styles/lists.css";
import "./styles/conversation.css";
import "./styles/screens.css";
import "./styles/resources.css";
import "./styles/terminal.css";
import "./styles/connect.css";
import { bootstrapDesktop } from "./live/desktop";

async function start() {
  try {
    await bootstrapDesktop();
    await import("./render");
  } catch (error) {
    const root = document.getElementById("root")!;
    root.replaceChildren();
    const panel = document.createElement("main");
    panel.style.cssText = "max-width:440px;margin:18vh auto;padding:32px;font:15px system-ui;line-height:1.65";
    const title = document.createElement("h1");
    title.textContent = "工作台暂时无法打开";
    const message = document.createElement("p");
    message.textContent = error instanceof Error ? error.message : String(error);
    const retry = document.createElement("button");
    retry.textContent = "重试";
    retry.style.cssText = "padding:8px 18px;border-radius:9px;cursor:pointer";
    retry.onclick = () => { retry.disabled = true; void start(); };
    panel.append(title, message, retry);
    root.append(panel);
  }
}

void start();
