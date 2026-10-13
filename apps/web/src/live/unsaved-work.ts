const unsaved = new Set<symbol>();

/** Register each editor independently so closing one cannot clear another's guard. */
export function registerUnsavedWork(): () => void {
  const key = Symbol("unsaved-editor");
  unsaved.add(key);
  return () => {
    unsaved.delete(key);
  };
}

export function hasUnsavedWork(): boolean {
  return unsaved.size > 0;
}
