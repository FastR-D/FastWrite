import { AsyncLocalStorage } from "node:async_hooks";

/** Serializes project mutations and snapshot reads, with scoped reentrancy. */
export class ProjectQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly context = new AsyncLocalStorage<{ id: string; active: boolean }>();

  async run<T>(id: string, operation: () => Promise<T>, allowReentry = true): Promise<T> {
    const current = this.context.getStore();
    if (allowReentry && current?.id === id && current.active) return operation();
    const previous = this.tails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const scope = { id, active: true };
      try { return await this.context.run(scope, operation); }
      finally { scope.active = false; }
    });
    this.tails.set(id, next);
    try { return await next; }
    finally { if (this.tails.get(id) === next) this.tails.delete(id); }
  }
}
