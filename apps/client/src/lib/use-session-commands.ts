import { useMemo } from "react";
import { Alert } from "react-native";
import { router } from "expo-router";
import type { ContentBlock, SessionConfigOption } from "@linkshell/wire";
import { useActions, useClient } from "./client";
import { parseCommand, sessionCommands } from "./commands";

const NO_COMMANDS: { name: string; description: string }[] = [];
const NO_CONFIG: SessionConfigOption[] = [];

/** Both typed commands and the picker resolve against the same live catalog. */
export function useSessionCommands(id: string) {
  const session = useClient((state) => state.sessions[id]);
  const view = useClient((state) => state.views[id]);
  const actions = useActions();
  const native = view?.commands ?? NO_COMMANDS;
  const config = view?.config ?? NO_CONFIG;
  const commands = useMemo(() => sessionCommands(session?.agent ?? "", native, config), [session?.agent, native, config]);

  const send = async (content: ContentBlock[]) => {
    const text = content.length === 1 && content[0]?.type === "text" ? content[0].text : undefined;
    const parsed = text ? parseCommand(text) : undefined;
    const command = parsed && commands.find((entry) => entry.name === parsed.name);
    if (!parsed || !command?.action || !session) return actions.send(id, content, session?.agent === "codex" && parsed && ["status", "mcp", "apps", "ps", "stop"].includes(parsed.name) ? { now: true } : undefined);
    const args = parsed.args;
    switch (command.action) {
      case "commands":
        router.push({ pathname: "/session/[id]/commands", params: { id } });
        break;
      case "tasks":
        router.push({ pathname: "/session/[id]/agents", params: { id } });
        break;
      case "goal":
        if (args && args !== "edit") return actions.send(id, content, { now: true });
        router.push({ pathname: "/session/[id]/goal", params: { id } });
        break;
      case "settings": {
        const option = config.find((entry) => entry.id === command.optionId);
        if (command.name === "plan" && !args && option) {
          await actions.setConfig(id, option.id, option.id === "plan" ? "on" : "plan");
          break;
        }
        if (!args || !option) {
          router.push({ pathname: "/session/[id]/settings", params: { id, option: command.optionId } });
          break;
        }
        const value = option.values.find((entry) => entry.value.toLowerCase() === args.toLowerCase() || entry.name.toLowerCase() === args.toLowerCase());
        if (!value) {
          if (command.name === "plan") {
            await actions.setConfig(id, option.id, option.id === "plan" ? "on" : "plan");
            return actions.send(id, [{ type: "text", text: args }]);
          }
          throw new Error(`可选值：${option.values.map((entry) => entry.value).join("、")}`);
        }
        await actions.setConfig(id, option.id, value.value);
        break;
      }
      case "changes":
        router.push({ pathname: "/session/[id]/changes", params: { id } });
        break;
      case "rename":
        if (args) await actions.rename(id, args);
        else router.push({ pathname: "/rename", params: { id } });
        break;
      case "new": {
        if (args) throw new Error("请先新建会话，再输入消息");
        const created = await actions.createSession({ agent: session.agent, cwd: session.cwd });
        router.push({ pathname: "/session/[id]", params: { id: created.id } });
        break;
      }
      case "fork": {
        if (args) throw new Error("/fork 不需要参数，请在分叉后的会话中继续");
        const created = await actions.forkSession(id);
        router.push({ pathname: "/session/[id]", params: { id: created.id } });
        break;
      }
      case "context": {
        const usage = view?.usage;
        Alert.alert("上下文占用", usage?.contextWindow ? `${usage.usedTokens ?? 0} / ${usage.contextWindow} tokens` : "Agent 尚未报告上下文用量");
        break;
      }
    }
    return "handled" as const;
  };
  return { commands, send };
}
