import type { PermissionOption } from "@linkshell/wire";

/**
 * The English a question request can arrive with, as the apps show it. Only these exact strings
 * are reworded; anything else an agent writes is shown as written.
 */

const titles: Record<string, string> = {
  // claude-agent-acp's title for an AskUserQuestion with more than one question (elicitation.js).
  "Please answer the following questions.": "请回答以下问题",
};

/** A question request's title in the apps' words, when it is one an agent always sends in English. */
export function questionTitle(title: string): string {
  return titles[title] ?? title;
}

// The host's own choices beside a question's answers (QUESTION_OPTIONS in packages/host/src/questions.ts),
// in English on the hosts released so far. Keyed by id and name, so an agent's own "Skip" stays its own.
const optionNames: Record<string, Record<string, string>> = {
  skip: { Skip: "跳过" },
  cancel: { Stop: "停止" },
};

/** A permission option's name in the apps' words, when it is one of the host's English question choices. */
export function questionOptionName(option: Pick<PermissionOption, "optionId" | "name">): string {
  return optionNames[option.optionId]?.[option.name] ?? option.name;
}

// Claude marks the option it suggests with "(Recommended)" at the end of the label; Antigravity puts it first.
const recommended = /^\s*[(（]recommended[)）]\s*|\s*[(（]recommended[)）]\s*$/i;

/**
 * An option's label without the agent's English "(Recommended)" mark, and whether it had one: the
 * apps show the mark as their own 推荐 badge. The label sent back to the agent is not changed.
 */
export function recommendedLabel(label: string): { text: string; recommended: boolean } {
  const text = label.replace(recommended, "");
  return text && text !== label ? { text, recommended: true } : { text: label, recommended: false };
}
