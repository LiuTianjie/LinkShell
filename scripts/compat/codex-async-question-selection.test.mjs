import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { prepareSelectionPatch, readDesktopAsset, simulateSelection } from "./codex-async-question-selection.mjs";

const app = process.env.LINKSHELL_CODEX_COMPAT_APP ?? "/Applications/ChatGPT.app";
const available = existsSync(`${app}/Contents/Resources/app.asar`);
const patch = available ? prepareSelectionPatch(readDesktopAsset(app)) : undefined;
const run = (fixture) => simulateSelection(patch.patched, fixture);
const fixture = { questions: ["one", "two"], selected: ["one", "two"] };

test("refuses an unknown desktop build instead of replacing an unrelated expression", () => {
  assert.throws(() => prepareSelectionPatch("function unknown(){}"), /Unsupported desktop build/);
});
test("reproduces stale selection using the installed desktop function", { skip: !available }, () => {
  assert.deepEqual(simulateSelection(patch.original, { ...fixture, answers: { one: "yes" } }).selected, ["one", "two"]);
});
test("closes the answered selection while retaining its unanswered sibling", { skip: !available }, () => {
  const state = run({ ...fixture, answers: { one: "yes" } });
  assert.deepEqual(state.selected, ["two"]);
  assert.equal(state.drafts.one.lastSubmission, "yes");
});
test("closes the editor after all selected questions have confirmed replies", { skip: !available }, () => {
  assert.deepEqual(run({ ...fixture, answers: { one: "yes", two: "no" } }).selected, []);
});
test("preserves a newer local draft when a previous remote answer arrives", { skip: !available }, () => {
  const state = run({ ...fixture, answers: { one: "yes" }, drafts: { one: { draft: "changed answer", draftBaseline: "" } } });
  assert.deepEqual(state.selected, ["one", "two"]);
  assert.equal(state.drafts.one.draft, "changed answer");
});
test("does not retain a draft matching the submitted answer", { skip: !available }, () => {
  assert.deepEqual(run({ ...fixture, answers: { one: "yes" }, drafts: { one: { draft: " yes ", draftBaseline: "" } } }).selected, ["two"]);
});
test("does not dismiss an unanswered question for another question's reply", { skip: !available }, () => {
  assert.deepEqual(run({ ...fixture, answers: { unrelated: "yes" } }).selected, ["one", "two"]);
});
