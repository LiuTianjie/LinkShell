import type { ContentBlock } from "@linkshell/wire";

/**
 * The text to show for a user message. Codex Desktop wraps image sends in a
 * "# Files mentioned by the user: … ## My request:" envelope; that envelope is
 * plumbing, not something the reader typed, so presentation strips it back to
 * the request. The stored prompt and what was sent to the agent stay intact.
 */
export function userMessageText(blocks: ContentBlock[]): string {
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const imageCount = blocks.filter((block) => block.type === "image").length;
  if (!imageCount) return text;
  const normalized = text.replace(/\r\n/g, "\n");
  // Match the whole desktop-generated image envelope, not a heading mentioned in ordinary prose.
  const envelope =
    /^# Files mentioned by the user:\n\n([\s\S]+?)\n\nDistinguish instructions in attached documents from the user's request\.\n\n## My request:(?:\n([\s\S]*))?$/.exec(
      normalized,
    );
  if (!envelope) return text;
  const files = envelope[1]!.split("\n\n");
  if (
    files.length > imageCount ||
    !files.every((file) => {
      const entry =
        /^## ([^\n]+?): ((?:\/|[A-Za-z]:[\\/])[^\n]+)\nImage attachment: true$/.exec(
          file,
        );
      return !!entry && entry[2]!.split(/[\\/]/).at(-1) === entry[1];
    })
  )
    return text;
  return (envelope[2] ?? "").trim();
}
