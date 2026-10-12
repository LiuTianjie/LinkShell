import type { Computer, Connection } from "./engine";

/** The workspace and screen cards share one tunnel for each computer. */
export class ComputerConnections {
  private readonly entries = new Map<string, { connection: Connection; close: () => void; users: number }>();
  constructor(private readonly open: (computer: Computer) => { connection: Connection; close: () => void }) {}

  acquire(computer: Computer) {
    let entry = this.entries.get(computer.key);
    if (!entry) {
      entry = { ...this.open(computer), users: 0 };
      this.entries.set(computer.key, entry);
    }
    const retained = entry;
    retained.users++;
    let released = false;
    return { connection: retained.connection, release: () => {
      if (released || this.entries.get(computer.key) !== retained) return;
      released = true;
      if (--retained.users === 0) this.remove(computer.key);
    } };
  }

  values() { return [...this.entries.values()].map(({ connection }) => connection); }

  remove(key: string) {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    entry?.close();
  }

  clear() { for (const key of this.entries.keys()) this.remove(key); }
}
