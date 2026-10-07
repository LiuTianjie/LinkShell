/** Byte cursors stay stable as output grows; never split a UTF-8 character. */
export function outputRange(bytes: Buffer, before: number | undefined, limit: number) {
  const size = bytes.length;
  let end = Math.min(size, Math.max(0, before ?? size));
  while (end < size && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  // A writer can be in the middle of a multibyte character at EOF.
  let tail = end - 1;
  while (tail >= 0 && (bytes[tail]! & 0xc0) === 0x80) tail--;
  if (tail >= 0) {
    const lead = bytes[tail]!;
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (tail + width > end) end = tail;
  }
  let start = Math.max(0, end - Math.max(4, Math.min(limit, 256 * 1024)));
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start, end).toString("utf8"), start, size };
}
