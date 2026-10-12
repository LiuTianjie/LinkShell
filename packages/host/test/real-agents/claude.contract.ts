import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { binaries, completed, content, harness, until } from "./support.js";

let run: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await run?.close(); run = undefined; });

it("claude-handoff: desktop to phone to desktop preserves native context", async () => {
  run = await harness("claude", ({ body }) => {
    const messages = JSON.stringify(body.messages);
    if (messages.includes("LS_CLAUDE_BACK")) return { text: messages.includes("LS_CLAUDE_PHONE") && messages.includes("PELICAN-42") ? "BACK-OK" : "HISTORY-MISSING" };
    if (messages.includes("LS_CLAUDE_PHONE")) return { text: messages.includes("PELICAN-42") ? "PELICAN-42" : "HISTORY-MISSING" };
    return { text: "STORED" };
  });
  const desktop = await run.connect(), phone = await run.connect();
  const launched = await desktop.client.call("desktop.launch", { agent: "claude", cwd: run.workspace, args: ["-p", "LS_CLAUDE_SEED PELICAN-42"] });
  const id = launched.sessionId!;
  const initial = await run.launch(launched.command, launched.args).done;
  expect(initial).toMatchObject({ code: 0 }); expect(initial.output).toContain("STORED");
  await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
  await until(() => phone.text(id).includes("STORED"), "native transcript visible on phone");
  expect(phone.text(id)).toContain("STORED");
  // The launcher has exited; yielding still acknowledges the desktop ownership transfer.
  let yielded = 0;
  desktop.client.on("desktop.yield", ({ sessionId }) => { yielded++; void desktop.client.call("desktop.yielded", { sessionId }); });
  await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "phone", content: content("LS_CLAUDE_PHONE What was the code word?") });
  await until(() => phone.text(id).includes("PELICAN-42") && completed(phone.events, id).length > 0, "ACP phone continuation", 30_000);
  expect(yielded).toBe(1);
  const back = await desktop.client.call("desktop.reclaim", { sessionId: id });
  expect(back.command).toBe(binaries.claude);
  expect(back.args).toEqual(["--resume", id.slice("claude:".length)]);
  const continued = await run.launch(back.command, [...back.args, "-p", "LS_CLAUDE_BACK Continue from the phone turn."]).done;
  expect(continued).toMatchObject({ code: 0 }); expect(continued.output).toContain("BACK-OK");
  await until(() => phone.text(id).includes("BACK-OK"), "desktop continuation visible on phone");
  const users = phone.events.filter((event) => event.update.sessionUpdate === "user_message_chunk");
  expect(users).toHaveLength(3);
  expect(phone.text(id)).toBe("STOREDPELICAN-42BACK-OK");
  expect(run.api.requests.filter(({ body }) => JSON.stringify(body.messages).includes("LS_CLAUDE_PHONE")).length).toBeGreaterThan(0);
  expect(run.api.errors).toEqual([]);
});

it("claude-active-handoff: stops the desktop writer before ACP and enforces approvals", async () => {
  let stopped = false;
  run = await harness("claude", ({ body }) => {
    const messages = JSON.stringify(body.messages);
    const tool = messages.includes("LS_CLAUDE_DENY") ? "denied" : "approved";
    if (messages.includes("LS_CLAUDE_ALLOW") || messages.includes("LS_CLAUDE_DENY")) {
      if (!stopped) throw new Error("ACP wrote before the desktop exited");
      if (!messages.includes(`tool_${tool}`)) return { tool: "Bash", id: `tool_${tool}`, arguments: { command: `printf ${tool} > ${tool}.txt`, description: "Write the regression marker" } };
      return { text: `${tool.toUpperCase()}-DONE` };
    }
    return messages.includes("LS_CLAUDE_ACTIVE") ? { hold: true } : { text: "READY" };
  });
  const desktop = await run.connect(), phone = await run.connect();
  const launch = await desktop.client.call("desktop.launch", { agent: "claude", cwd: run.workspace, args: ["-p", "LS_CLAUDE_START"] });
  const id = launch.sessionId!;
  expect(await run.launch(launch.command, launch.args).done).toMatchObject({ code: 0 });
  const native = run.launch(launch.command, ["--resume", id.slice(7), "-p", "LS_CLAUDE_ACTIVE"]);
  await until(() => run!.api.held.size === 1, "desktop inference active");
  await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
  let yielded = 0;
  desktop.client.on("desktop.yield", ({ sessionId }) => {
    yielded++;
    void (async () => {
      native.child.kill("SIGTERM"); await native.done; stopped = true;
      await desktop.client.call("desktop.yielded", { sessionId });
    })();
  });
  for (const [marker, kind] of [["ALLOW", "allow_once"], ["DENY", "reject_once"]] as const) {
    const before = phone.events.length, turns = completed(phone.events, id).length;
    await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: marker, content: content(`LS_CLAUDE_${marker}`) });
    await until(() => phone.events.slice(before).some((event) => event.update.sessionUpdate === "ls_permission"), `${marker} real Bash approval`, 30_000);
    const permission = phone.events.slice(before).find((event) => event.update.sessionUpdate === "ls_permission")!.update;
    if (permission.sessionUpdate !== "ls_permission") throw new Error("missing permission");
    const file = join(run.workspace, marker === "ALLOW" ? "approved.txt" : "denied.txt");
    expect(existsSync(file)).toBe(false);
    await phone.client.call("sessions.permission", { sessionId: id, requestId: permission.requestId, optionId: permission.options.find((option) => option.kind === kind)!.optionId });
    await until(() => completed(phone.events, id).length > turns, `${marker} completion`, 30_000);
    if (marker === "ALLOW") expect(readFileSync(file, "utf8")).toBe("approved");
    else expect(existsSync(file)).toBe(false);
  }
  expect(yielded).toBe(1); expect(stopped).toBe(true);
  expect(run.api.errors).toEqual([]);
});
