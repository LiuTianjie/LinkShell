import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { answeredQuestions, type AsyncQuestion } from "@linkshell/wire";
import { asyncQuestions } from "./mapper.js";

export interface CodexAttention { running: boolean; questions: AsyncQuestion[] }

/** Read only the current turn, so list badges work without taking ownership of the thread. */
export function rolloutAttention(path: string, chunk = 256 * 1024, limit = 16 * 1024 * 1024): CodexAttention | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return undefined; }
  try {
    const size = fstatSync(fd).size;
    let end = size;
    let prefix = Buffer.alloc(0);
    const questions: AsyncQuestion[] = [];
    const answered = new Set<string>();
    while (end > 0 && size - end < limit) {
      const start = Math.max(0, end - Math.min(chunk, limit - (size - end)));
      const bytes = Buffer.alloc(end - start);
      readSync(fd, bytes, 0, bytes.length, start);
      let data = Buffer.concat([bytes, prefix]);
      // A writer may still be appending the last record.
      if (end === size) data = data.subarray(0, data.lastIndexOf(10) + 1);
      end = start;
      const first = start === 0 ? 0 : data.indexOf(10) + 1;
      if (first === 0 && start > 0) { prefix = data; continue; }
      const lines = data.subarray(first).toString("utf8").split("\n");
      prefix = data.subarray(0, first);
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        if (!line.includes('"task_') && !line.includes('"turn_aborted"') && !line.includes("request_user_input_async") && !line.includes("send_user_message_question_reply")) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const payload = entry.payload;
        if (!payload || typeof payload !== "object") continue;
        if (entry.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) return { running: false, questions: [] };
        if (entry.type === "event_msg" && payload.type === "task_started") {
          return { running: true, questions: questions.filter((question) => !answered.has(question.id)) };
        }
        if (entry.type !== "response_item") continue;
        if (payload.type === "function_call" && typeof payload.name === "string" && /(?:^|\.)request_user_input_async$/.test(payload.name)) {
          try {
            const args = JSON.parse(payload.arguments);
            questions.unshift(...(asyncQuestions({ id: payload.call_id, delivery: "async", questions: args.questions }) ?? []));
          } catch { /* Incomplete arguments cannot make an actionable question. */ }
        }
        if (payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
          for (const block of payload.content) {
            if (typeof block?.text === "string") for (const [id] of answeredQuestions(block.text)) answered.add(id);
          }
        }
      }
    }
    // Unknown is not idle: do not clear a known pending question on a bounded read.
    return undefined;
  } catch { return undefined; }
  finally { closeSync(fd); }
}
