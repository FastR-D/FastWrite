import type { HarnessEvent } from "@fastwrite/harness-protocol";

type HarnessEventListener = (event: HarnessEvent) => void;

export class HarnessEventBus {
  readonly #listeners = new Map<string, Set<HarnessEventListener>>();

  subscribe(runId: string, listener: HarnessEventListener): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(runId);
    };
  }

  publish(event: HarnessEvent): void {
    for (const listener of this.#listeners.get(event.runId) ?? []) listener(event);
  }
}

export const harnessEventBus = new HarnessEventBus();
