import { describe, expect, it } from "vitest";
import type { PendingPermissionSummary } from "@linkshell/wire";
import { permissionContent } from "../src/permission-content.js";

const request = (tool: PendingPermissionSummary["tool"], detail?: string): PendingPermissionSummary => ({
  requestId: "approve-plan", title: "ExitPlanMode", detail, tool,
  options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
});

describe("plan approval content", () => {
  it("renders the plan once while retaining requested command permissions and warnings", () => {
    const plan = "# 修改计划\n\n- 先检查\n- 再修改\n\n```sh\npnpm build\n```";
    const allowedPrompts = [{ tool: "Bash", prompt: "run the build" }];
    const approval = request({ rawInput: { plan, allowedPrompts }, content: [{ type: "content", content: { type: "text", text: plan } }] }, "需要允许构建命令");
    expect(permissionContent(approval)).toEqual({ markdown: plan, detail: approval.detail, rawInput: { allowedPrompts }, content: [] });
    expect(approval.tool?.rawInput).toEqual({ plan, allowedPrompts });
  });

  it("reads ACP mode-switch Markdown while preserving non-text tool content", () => {
    const plan = "## Plan\n\n1. Inspect\n2. Fix";
    const diff = { type: "diff" as const, path: "plan.md", oldText: "", newText: plan };
    expect(permissionContent(request({ kind: "switch_mode", content: [{ type: "content", content: { type: "text", text: plan } }, diff] }, plan)))
      .toEqual({ markdown: plan, detail: undefined, rawInput: undefined, content: [diff] });
  });

  it("keeps ordinary command and file approvals as exact text", () => {
    const approval = request({ kind: "execute", rawInput: { command: "printf '# literal'" }, content: [{ type: "content", content: { type: "text", text: "# command output" } }] }, "运行命令");
    expect(permissionContent(approval)).toEqual({ markdown: undefined, detail: approval.detail, rawInput: approval.tool?.rawInput, content: approval.tool?.content });
  });
});
