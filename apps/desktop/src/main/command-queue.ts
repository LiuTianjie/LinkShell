export type PageCommand = Record<string, unknown> & { command: string };

/**
 * Commands for the page that arrive before it can take them (a second launch, a notification
 * click, ⌘W during a reload). They are delivered in order once it is ready. Navigation-like
 * commands only matter in their latest form, so a newer one replaces an older one of the same
 * kind; the queue is bounded so a page that never loads can't grow it without end.
 */
const LATEST_ONLY = new Set(["manage", "workspace", "open-session", "fusion"]);

export class CommandQueue {
  private items: PageCommand[] = [];

  constructor(private readonly limit = 16) {}

  get size(): number { return this.items.length; }

  push(command: PageCommand): void {
    if (LATEST_ONLY.has(command.command)) this.items = this.items.filter((item) => item.command !== command.command);
    // Repeated ⌘W while the page is away closes one tab, not several the person can't see.
    else if (this.items.some((item) => JSON.stringify(item) === JSON.stringify(command))) return;
    this.items.push(command);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  drain(): PageCommand[] {
    const items = this.items;
    this.items = [];
    return items;
  }

  clear(): void { this.items = []; }
}
