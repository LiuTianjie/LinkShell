/** `items` in the order of `ids`; what `ids` doesn't name keeps its place after them. */
export function inOrder<T extends { clientMessageId: string }>(items: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(a.item.clientMessageId) ?? ids.length) - (rank.get(b.item.clientMessageId) ?? ids.length) || a.index - b.index)
    .map((entry) => entry.item);
}
