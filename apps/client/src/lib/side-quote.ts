import { create } from "zustand";

/** A quote is cut here: a side question is about a passage, not a whole reply. */
const MAX_QUOTE_CHARS = 2000;

/**
 * Text picked in a session's reply to ask a side question about, waiting for
 * the side conversation (a sheet or a panel) to pick it up.
 */
export const useSideQuotes = create<{ quotes: Record<string, string> }>(() => ({ quotes: {} }));

export function quoteForSide(sessionId: string, text: string): void {
  const quote = text.trim();
  if (!quote) return;
  const cut = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
  useSideQuotes.setState((state) => ({ quotes: { ...state.quotes, [sessionId]: cut } }));
}

export function takeSideQuote(sessionId: string): string | undefined {
  const quote = useSideQuotes.getState().quotes[sessionId];
  if (quote === undefined) return undefined;
  useSideQuotes.setState((state) => {
    const { [sessionId]: _taken, ...rest } = state.quotes;
    return { quotes: rest };
  });
  return quote;
}

/** The question as the agent gets it: the passage as a Markdown quote, then what is asked about it. */
export function withQuote(quote: string | undefined, question: string): string {
  if (!quote) return question;
  return `${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${question}`;
}

/** Splits a question asked with `withQuote` back into the passage and the question. */
export function splitQuote(text: string): { quote?: string; question: string } {
  if (!text.startsWith(">")) return { question: text };
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && lines[end]!.startsWith(">")) end++;
  const quote = lines.slice(0, end).map((line) => line.replace(/^> ?/, "")).join("\n");
  return { quote, question: lines.slice(end).join("\n").trim() };
}
