import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { MethodResult } from "@linkshell/wire";
import type { Connection } from "../src/live/engine";
import { Runtime } from "../src/live/common";
import { NewSessionPage } from "../src/live/NewSessionPage";

const listed = vi.hoisted(() => ({ value: undefined as MethodResult<"agents.models"> | undefined }));
vi.mock("../src/live/agent-models", async (original) => ({
  ...(await original<typeof import("../src/live/agent-models")>()),
  useAgentModels: () => listed.value,
}));
vi.mock("../src/live/engine", async () => ({ engine: { state: (await import("zustand/vanilla")).createStore(() => ({})) } }));
vi.mock("../src/live/computer-names", async () => ({
  computerNames: { store: (await import("zustand/vanilla")).createStore(() => ({})) },
  computerName: () => "Mac",
}));
vi.mock("../src/live/Files", () => ({ Files: () => null }));
vi.mock("../src/live/Acp", () => ({ AgentInteractions: () => null }));

function render(models: MethodResult<"agents.models"> | undefined) {
  listed.value = models;
  const connection = {
    store: createStore(() => ({
      status: "online",
      machine: { home: "/Users/me", agents: [{ id: "codex", label: "Codex", installed: true, tier: "multi_client" }] },
      projects: [{ cwd: "/work/app", name: "app" }],
      gitInfo: async () => undefined,
    })),
    link: {},
  } as unknown as Connection;
  return renderToStaticMarkup(createElement(Runtime.Provider, { value: connection }, createElement(NewSessionPage, { created: () => {}, cancel: () => {} })));
}

describe("new session page: the model", () => {
  it("is a pill beside the agent's, showing the agent's default", () => {
    const markup = render({ models: [{ value: "gpt-big", name: "GPT Big" }, { value: "gpt-mini", name: "GPT Mini" }], current: "gpt-big" });
    expect(markup).toContain('aria-label="选择模型"');
    expect(markup).toContain("GPT Big");
    expect(markup.indexOf('aria-label="选择 Agent"')).toBeLessThan(markup.indexOf('aria-label="选择模型"'));
    expect(markup.indexOf('aria-label="选择模型"')).toBeLessThan(markup.indexOf('aria-label="选择工作目录"'));
  });

  it("reads Claude's default in Chinese, as the composer does", () => {
    expect(render({ models: [{ value: "default", name: "Default (recommended)" }, { value: "opus", name: "Opus" }], current: "default" })).toContain("默认（推荐）");
  });

  it("isn't there when there is nothing to choose, or while the agent is asked", () => {
    for (const models of [{ models: [] }, undefined]) {
      const markup = render(models);
      expect(markup).not.toContain("选择模型");
      expect(markup).toContain('aria-label="选择 Agent"');
      expect(markup).toContain('aria-label="选择工作目录"');
    }
  });
});
