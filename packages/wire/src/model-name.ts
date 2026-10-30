/** Format a raw GPT model ID for display without changing the value sent to the agent. */
export function displayModelName(name: string): string {
  const match = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z][a-z0-9-]*))?$/i.exec(name.trim());
  if (!match) return name;
  const suffix = match[2]?.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  return `GPT-${match[1]}${suffix ? ` ${suffix}` : ""}`;
}
