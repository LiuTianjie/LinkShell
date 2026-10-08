/** Several visible panes can share one session without closing each other's stream. */
export function createSessionSubscriptions(open: (id: string) => void, close: (id: string) => void) {
  const counts = new Map<string, number>();
  return (id: string) => {
    const count = counts.get(id) ?? 0;
    if (count === 0) open(id);
    counts.set(id, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (counts.get(id) ?? 1) - 1;
      if (remaining > 0) counts.set(id, remaining);
      else {
        counts.delete(id);
        close(id);
      }
    };
  };
}
