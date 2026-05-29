/**
 * Serializes async writes that share a storage key.
 *
 * AsyncStorage offers no atomicity for read-modify-write sequences, so two
 * concurrent `load → mutate → save` flows on the same key race and the last
 * writer silently clobbers the other's mutation. `enqueueWrite` chains work
 * per key: each call runs only after the previous call for that key settles,
 * so the read inside `fn` always observes the prior write's result.
 *
 * IMPORTANT: the entire read-modify-write must live inside `fn` for the
 * serialization to actually prevent lost updates.
 */
const writeChains = new Map<string, Promise<unknown>>();

export function enqueueWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  // Run fn after prev settles, regardless of whether prev resolved or rejected,
  // so one failed write doesn't wedge the chain for that key.
  const result = prev.then(fn, fn);
  writeChains.set(key, result);
  // Drain the map entry once this is the tail and it has settled. Swallow the
  // rejection here so cleanup never produces an unhandled rejection; the
  // returned `result` still rejects for the caller.
  void result
    .catch(() => {})
    .then(() => {
      if (writeChains.get(key) === result) {
        writeChains.delete(key);
      }
    });
  return result;
}
