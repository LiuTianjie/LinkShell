import type { Computer, Connection } from "./engine";

/** The workspace and screen cards share one tunnel for each computer. */
export class ComputerConnections {
  private readonly entries = new Map<string, { connection: Connection; close: () => void; users: number; streamUsers: number }>();
  constructor(private readonly open: (computer: Computer) => { connection: Connection; close: () => void }) {}

  acquire(computer: Computer, options?: { metadataOnly?: boolean }) {
    let entry = this.entries.get(computer.key);
    if (!entry) {
      entry = { ...this.open(computer), users: 0, streamUsers: 0 };
      this.entries.set(computer.key, entry);
    }
    const retained = entry;
    retained.users++;
    const streams = !options?.metadataOnly;
    if (streams && retained.streamUsers++ === 0) {
      try { retained.connection.streams.start(); }
      catch (error) {
        retained.streamUsers--;
        if (--retained.users === 0) this.remove(computer.key);
        else retained.connection.streams.stop();
        throw error;
      }
    }
    let released = false;
    return { connection: retained.connection, release: () => {
      if (released || this.entries.get(computer.key) !== retained) return;
      released = true;
      if (streams) retained.streamUsers--;
      if (--retained.users === 0) this.remove(computer.key);
      // A project overview keeps RPC alive, but must not retain an unused bulk connection.
      else if (streams && retained.streamUsers === 0) retained.connection.streams.stop();
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
