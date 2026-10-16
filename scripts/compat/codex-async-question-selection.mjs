import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A reviewable patch for this desktop build, never an automatic app modification.
const ASSET = "webview/assets/app-initial-1ab6fbe93c4f.js";
const BEFORE = "s.questionIds.filter(e=>n.includes(e))";
const AFTER = "s.questionIds.filter(r=>{if(!n.includes(r))return!1;let a=i.get(r);if(a==null)return!0;let o=jS.resolve(e.node,e.chain,{...s.selectedQuestionKey,itemId:r}).get();return o!=null&&o.draft!==o.draftBaseline&&o.draft.trim()!==a})";
const BEFORE_SELECTION = "t.includes(s.selectedQuestionKey.itemId)?t.length!==s.questionIds.length&&kS(e,o,{...s,questionIds:t}):kS(e,o,null)";
const AFTER_SELECTION = "t.length===0?kS(e,o,null):(t.length!==s.questionIds.length||!t.includes(s.selectedQuestionKey.itemId))&&kS(e,o,{...s,selectedQuestionKey:t.includes(s.selectedQuestionKey.itemId)?s.selectedQuestionKey:{...s.selectedQuestionKey,itemId:t[0]},questionIds:t})";

export function prepareSelectionPatch(source) {
  const start = source.indexOf("function DIt(e,t,n){");
  const end = source.indexOf("function OIt(", start);
  if (start < 0 || end < 0) throw new Error("Unsupported desktop build: reconciliation function not found");
  const original = source.slice(start, end);
  if (!original.includes("answersByQuestionItemId:i") || !original.includes("jS.resolve(e.node,e.chain")) {
    throw new Error("Unsupported desktop build: answer/draft bindings changed");
  }
  if (original.split(BEFORE).length !== 2) throw new Error("Expected exactly one unpatched selection filter");
  if (original.split(BEFORE_SELECTION).length !== 2) throw new Error("Unsupported desktop build: selection update changed");
  const patched = original.replace(BEFORE, AFTER).replace(BEFORE_SELECTION, AFTER_SELECTION);
  return { original, patched, source: source.slice(0, start) + patched + source.slice(end) };
}

export function readDesktopAsset(appPath) {
  const archive = readFileSync(resolve(appPath, "Contents/Resources/app.asar"));
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString("utf8"));
  let entry = header;
  for (const segment of ASSET.split("/")) entry = entry.files?.[segment];
  if (!entry || entry.unpacked) throw new Error("Unsupported desktop build: expected bundled asset is missing");
  const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset);
  return archive.subarray(offset, offset + entry.size).toString("utf8");
}

/** Run the installed reconciler against isolated state; no desktop IPC or UI is touched. */
export function simulateSelection(reconciler, { questions, selected, answers = {}, drafts = {} }) {
  const key = { hostId: "local", threadId: "fixture-thread", entityKey: "fixture-turn" };
  const state = {
    selected: { selectedQuestionKey: { ...key, itemId: selected[0] }, questionIds: selected },
    ids: [...questions],
    drafts: new Map(questions.map((id) => [id, {
      turnId: "turn-1", title: id, draft: "", draftBaseline: "", lastSubmission: null,
      isSubmitting: false, isSkipped: false, ...drafts[id],
    }])),
  };
  const AS = { resolve: () => ({ get: () => state.ids }) };
  const jS = { resolve: (_node, _chain, k) => ({ get: () => state.drafts.get(k.itemId) }) };
  const BIt = { resolve: () => ({ get: () => new Map([[key.threadId, state.selected]]) }) };
  const context = { node: {}, chain: {}, set(atom, k, value) {
    if (atom === AS) state.ids = value;
    else state.drafts.set(k.itemId, value);
  } };
  const run = new Function("Mc", "BIt", "kS", "AS", "jS", "yue", "Rie", `return (${reconciler});`)(
    (_context, body) => body(), BIt, (_context, _key, selection) => { state.selected = selection; }, AS, jS,
    () => ({ answersByQuestionItemId: new Map(Object.entries(answers)) }),
    () => questions.map((id) => ({ id, title: id })),
  );
  run(context, key, { turnId: "turn-1", items: [] });
  return { selected: state.selected?.questionIds ?? [], drafts: Object.fromEntries(state.drafts) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const app = args[0] ?? "/Applications/ChatGPT.app";
  const output = args.indexOf("--output");
  const source = readDesktopAsset(app);
  const patch = prepareSelectionPatch(source);
  const fixture = { questions: ["answered"], selected: ["answered"], answers: { answered: "yes" } };
  const before = simulateSelection(patch.original, fixture).selected;
  const after = simulateSelection(patch.patched, fixture).selected;
  if (before.length !== 1 || after.length !== 0) throw new Error("Patch failed the installed-build regression check");
  const manifest = {
    target: ASSET, sourceSha256: createHash("sha256").update(source).digest("hex"),
    replacementSha256: createHash("sha256").update(patch.source).digest("hex"),
    scope: "DIt async-question selection reconciliation",
    edits: [{ find: BEFORE, replace: AFTER }, { find: BEFORE_SELECTION, replace: AFTER_SELECTION }],
    applicationModified: false,
    installationBoundary: "Repacking an official signed app requires re-signing and restarting it; this command does neither.",
  };
  if (output >= 0) {
    if (!args[output + 1]) throw new Error("--output requires a new manifest path");
    writeFileSync(args[output + 1], JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify({ ...manifest, regression: { before, after } }, null, 2));
}
