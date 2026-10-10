import type { Question, QuestionAnswer } from "./model.js";

/** Shared validation keeps the phone's feedback and the host's acceptance identical. */
export function questionAnswerError(question: Question, answer: QuestionAnswer | undefined): string | undefined {
  const label = question.header ?? question.text;
  const values = answer?.values ?? [];
  const c = question.constraints;
  if (values.length > 1 && question.kind !== "choices") return `${label}只能填写一个答案`;
  if (question.options && values.some((value) => !question.options!.some((option) => option.value === value))) return `${label}包含无效选项`;
  const present = c?.type === "array" ? answer !== undefined : c?.type === "string" ? values[0] !== undefined || !!answer?.other?.trim() : values.some((value) => value !== "") || !!answer?.other?.trim();
  if (!present) return question.required ? `还没回答：${label}` : undefined;
  if (!c) return;
  const value = values[0] ?? "";
  if (c.type === "number" || c.type === "integer") {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || (c.type === "integer" && !Number.isInteger(number))) return `${label}需要填写${c.type === "integer" ? "整数" : "数字"}`;
    if (c.minimum !== undefined && number < c.minimum) return `${label}不能小于 ${c.minimum}`;
    if (c.maximum !== undefined && number > c.maximum) return `${label}不能大于 ${c.maximum}`;
  }
  if (c.type === "array") {
    if (new Set(values).size !== values.length) return `${label}不能重复选择`;
    if (c.minItems !== undefined && values.length < c.minItems) return `${label}至少选择 ${c.minItems} 项`;
    if (c.maxItems !== undefined && values.length > c.maxItems) return `${label}最多选择 ${c.maxItems} 项`;
  }
  if (c.type === "string") {
    const length = [...value].length;
    if (c.minLength !== undefined && length < c.minLength) return `${label}至少需要 ${c.minLength} 个字符`;
    if (c.maxLength !== undefined && length > c.maxLength) return `${label}最多允许 ${c.maxLength} 个字符`;
    if (c.pattern) {
      try { if (!new RegExp(c.pattern, "u").test(value)) return `${label}格式不符合要求`; }
      catch { return `${label}的格式规则无效`; }
    }
    if (c.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `${label}需要有效的邮箱地址`;
    if (c.format === "uri") { try { new URL(value); } catch { return `${label}需要完整的网址`; } }
    if (c.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return `${label}需要有效日期（YYYY-MM-DD）`;
    if (c.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))) return `${label}需要包含时区的有效日期时间`;
  }
  return;
}
