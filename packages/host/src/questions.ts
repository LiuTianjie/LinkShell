import type { PermissionOption, Question, QuestionAnswer } from "@linkshell/wire";

// Questions an agent asks the user. Claude's AskUserQuestion and MCP servers
// ask through a form (a small JSON schema, the same in ACP and MCP); Codex has
// its own shape. Both become `Question`s for the apps, and the answers go back
// in the shape each agent expects.

/** What a request with questions offers besides answering them. */
export const QUESTION_OPTIONS: PermissionOption[] = [
  { optionId: "skip", name: "Skip", kind: "reject_once" },
  { optionId: "cancel", name: "Stop", kind: "reject_once" },
];

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

interface FormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  /** The field that takes the user's own answer for this one (Claude: `question_0_custom`). */
  custom?: string;
}

export interface Form {
  questions: Question[];
  fields: FormField[];
}

function options(source: unknown): Question["options"] {
  const schema = obj(source);
  const titled = arr(schema?.oneOf ?? schema?.anyOf).flatMap((entry) => {
    const option = obj(entry);
    const value = str(option?.const);
    return value === undefined ? [] : [{ value, label: str(option?.title) ?? value, description: str(option?.description) }];
  });
  if (titled.length > 0) return titled;
  const names = arr(schema?.enumNames);
  const plain = arr(schema?.enum).flatMap((entry, index) => (typeof entry === "string" ? [{ value: entry, label: str(names[index]) ?? entry }] : []));
  return plain.length > 0 ? plain : undefined;
}

/** The fields that only carry a free-text answer for another field. */
function companions(properties: Json): Map<string, string> {
  const found = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    const base = /^(.+)_(custom|other)$/.exec(key)?.[1];
    if (base && properties[base] !== undefined && obj(properties[key])?.type === "string") found.set(key, base);
  }
  return found;
}

/**
 * A form's fields as questions, in the form's order. `message` is what the
 * form is about; it is the question itself when the form has one field.
 */
export function formQuestions(schema: unknown, message?: string): Form | undefined {
  const properties = obj(obj(schema)?.properties);
  if (!properties) return undefined;
  const required = new Set(arr(obj(schema)?.required).filter((entry): entry is string => typeof entry === "string"));
  const companionOf = companions(properties);
  const keys = Object.keys(properties).filter((key) => !companionOf.has(key));
  const form: Form = { questions: [], fields: [] };
  for (const key of keys) {
    const property = obj(properties[key]);
    const type = property?.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "array") continue;
    const custom = [...companionOf].find(([, base]) => base === key)?.[0];
    const title = str(property?.title);
    const text = str(property?.description) ?? (keys.length === 1 ? message : undefined) ?? title ?? key;
    const base = { id: key, header: title && title !== text ? title : undefined, text, required: required.has(key) || undefined };
    if (type === "array") {
      const choices = options(property?.items);
      if (!choices) continue;
      form.questions.push({ ...base, kind: "choices", options: choices, other: custom ? true : undefined });
    } else if (type === "boolean") {
      form.questions.push({ ...base, kind: "choice", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] });
    } else {
      const choices = type === "string" ? options(property) : undefined;
      form.questions.push(
        choices
          ? { ...base, kind: "choice", options: choices, other: custom ? true : undefined }
          : { ...base, kind: "text", secret: property?.format === "password" || undefined },
      );
    }
    form.fields.push({ key, type, custom });
  }
  return form.questions.length > 0 ? form : undefined;
}

/** The form filled in with the answers: what the agent gets as the form's content. */
export function formContent(form: Form, answers: QuestionAnswer[]): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.fields) {
    const answer = answers.find((entry) => entry.id === field.key);
    if (!answer) continue;
    const [first] = answer.values;
    if (field.type === "array") {
      if (answer.values.length > 0) content[field.key] = answer.values;
    } else if (first !== undefined && first !== "") {
      if (field.type === "boolean") content[field.key] = first === "true";
      else if (field.type === "string") content[field.key] = first;
      else if (Number.isFinite(Number(first))) content[field.key] = Number(first);
    }
    const own = answer.other?.trim();
    if (own && field.custom) content[field.custom] = own;
  }
  return content;
}
