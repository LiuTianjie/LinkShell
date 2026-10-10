import { z } from "zod";
import { RpcError, type Question, type QuestionAnswer, type SessionUpdate } from "@linkshell/wire";
import { QUESTION_OPTIONS, formContent, formQuestions } from "../../questions.js";

type PermissionUpdate = Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>;
export interface AcpQuestionRequest {
  update: PermissionUpdate;
  answer(answers: QuestionAnswer[]): unknown;
  respond(optionId: string): unknown;
}

/** Private extensions belong to their agent, not to every process speaking ACP. */
export function questionMethod(agent: string, method: string): "form" | "cursor" | "grok" | "grok-form" | undefined {
  if (method === "elicitation/create") return "form";
  if (agent === "cursor" && (method === "cursor/ask_question" || method === "_cursor/ask_question")) return "cursor";
  if (agent === "grok" && (method === "x.ai/ask_user_question" || method === "_x.ai/ask_user_question")) return "grok";
  if (agent === "grok" && (method === "x.ai/mcp/elicit" || method === "_x.ai/mcp/elicit")) return "grok-form";
  return undefined;
}

const cursorSchema = z.object({
  toolCallId: z.string().min(1), title: z.string().optional(),
  questions: z.array(z.object({
    id: z.string().min(1), prompt: z.string().min(1), allowMultiple: z.boolean().optional(),
    options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1),
  })).min(1),
});
const grokSchema = z.object({
  toolCallId: z.string().min(1),
  questions: z.array(z.object({
    question: z.string().min(1), multiSelect: z.boolean().nullish(), multi_select: z.boolean().nullish(),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional(), preview: z.string().nullish() })),
  })).min(1),
});
const formSchema = z.object({ mode: z.literal("form"), message: z.string().optional(), requestedSchema: z.unknown(), toolCallId: z.string().optional(), serverName: z.string().optional() });
const invalid = () => new RpcError(-32602, "Agent 的提问格式不受支持，未提交任何回答");
function unique(values: string[]) { if (new Set(values).size !== values.length) throw invalid(); }

/** The UI gets one question model; only these adapters know each agent's response format. */
export function mapAcpQuestions(agent: string, method: string, params: unknown, requestId: string): AcpQuestionRequest {
  const kind = questionMethod(agent, method);
  const update = (title: string, questions: Question[], toolCallId?: string, detail?: string): PermissionUpdate => ({
    sessionUpdate: "ls_permission", requestId, title, questions, toolCallId, detail, options: QUESTION_OPTIONS,
  });
  if (kind === "cursor") {
    const parsed = cursorSchema.safeParse(params);
    if (!parsed.success) throw invalid();
    const request = parsed.data;
    unique(request.questions.map((question) => question.id));
    for (const question of request.questions) unique(question.options.map((option) => option.id));
    return {
      update: update(request.title ?? "Cursor 有问题需要你回答", request.questions.map((question) => ({
        id: question.id, text: question.prompt, kind: question.allowMultiple ? "choices" : "choice",
        options: question.options.map((option) => ({ value: option.id, label: option.label })),
      })), request.toolCallId),
      answer: (answers) => ({ outcome: { outcome: "answered", answers: answers.filter((answer) => answer.values.length).map((answer) => ({ questionId: answer.id, selectedOptionIds: answer.values })) } }),
      respond: (optionId) => ({ outcome: { outcome: optionId === "cancel" ? "cancelled" : "skipped" } }),
    };
  }
  if (kind === "grok") {
    const parsed = grokSchema.safeParse(params);
    if (!parsed.success) throw invalid();
    const request = parsed.data;
    unique(request.questions.map((question) => question.question));
    for (const question of request.questions) unique(question.options.map((option) => option.label));
    const questions: Question[] = request.questions.map((question, index) => ({
      id: `question_${index}`, text: question.question,
      kind: question.options.length ? question.multiSelect || question.multi_select ? "choices" : "choice" : "text",
      options: question.options.length ? question.options.map((option) => ({
        value: option.label, label: option.label,
        // A selected preview goes back to Grok too, so it must be visible before submission.
        description: [option.description, option.preview].filter(Boolean).join("\n\n") || undefined,
      })) : undefined,
      other: question.options.length > 0 || undefined,
    }));
    return {
      update: update("Grok 有问题需要你回答", questions, request.toolCallId),
      answer: (answers) => {
        const selected: Record<string, string[]> = Object.create(null);
        const annotations: Record<string, { notes?: string; preview?: string }> = Object.create(null);
        for (const [index, question] of questions.entries()) {
          const answer = answers.find((entry) => entry.id === question.id);
          if (!answer || (!answer.values.length && !answer.other)) continue;
          const own = question.kind === "text" ? answer.values[0] : answer.other;
          selected[question.text] = question.kind !== "text" && answer.values.length ? answer.values : ["Other"];
          const preview = question.kind === "choice" && answer.values.length === 1
            ? request.questions[index]?.options.find((option) => option.label === answer.values[0])?.preview : undefined;
          if (own || preview) annotations[question.text] = { ...(own ? { notes: own } : {}), ...(preview ? { preview } : {}) };
        }
        return { outcome: "accepted", answers: selected, ...(Object.keys(annotations).length ? { annotations } : {}) };
      },
      // Skipping an interview is a distinct plan-mode action; an ordinary Skip only dismisses this question.
      respond: () => ({ outcome: "cancelled" }),
    };
  }
  if (kind === "form" || kind === "grok-form") {
    const url = z.object({ mode: z.literal("url"), message: z.string(), elicitationId: z.string(), url: z.string().url() }).safeParse(params);
    if (url.success && kind === "form") {
      if (!["https:", "http:"].includes(new URL(url.data.url).protocol)) throw invalid();
      return {
        update: { sessionUpdate: "ls_permission", requestId, title: url.data.message, url: { url: url.data.url, elicitationId: url.data.elicitationId }, options: [
          { optionId: "accept", name: "打开授权页面", kind: "allow_once" },
          { optionId: "decline", name: "拒绝", kind: "reject_once" },
          { optionId: "cancel", name: "取消", kind: "reject_once" },
        ] },
        answer: () => { throw invalid(); },
        respond: (optionId) => ({ action: optionId === "accept" ? "accept" : optionId === "cancel" ? "cancel" : "decline" }),
      };
    }
    const parsed = formSchema.safeParse(params);
    if (!parsed.success) throw invalid();
    const request = parsed.data;
    const form = formQuestions(request.requestedSchema, request.message);
    if (!form) throw invalid();
    const outcome = (action: string, content?: unknown) => ({ [kind === "grok-form" ? "outcome" : "action"]: action, ...(content === undefined ? {} : { content }) });
    return {
      update: update(request.message ?? form.questions[0]!.text, form.questions, request.toolCallId, request.serverName ? `来自 MCP 服务 ${request.serverName}` : undefined),
      answer: (answers) => outcome("accept", formContent(form, answers)),
      respond: (optionId) => outcome(optionId === "cancel" ? "cancel" : "decline"),
    };
  }
  throw invalid();
}
