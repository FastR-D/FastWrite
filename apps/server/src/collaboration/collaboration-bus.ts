export interface CollaborationBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>>;
}

export class InMemoryCollaborationBus implements CollaborationBus {
  private readonly listeners = new Map<string, Set<(message: string) => void>>();
  async publish(channel: string, message: string): Promise<void> { for (const listener of this.listeners.get(channel) ?? []) listener(message); }
  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> { const listeners = this.listeners.get(channel) ?? new Set(); listeners.add(listener); this.listeners.set(channel, listeners); return async () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(channel); }; }
}

export class RedisCollaborationBus implements CollaborationBus {
  private readonly subscriptions = new Map<string, number>();
  constructor(private readonly publisher: { publish(channel: string, message: string): Promise<unknown> }, private readonly subscriber: { subscribe(channel: string, listener: (message: string) => void): Promise<unknown>; unsubscribe(channel: string): Promise<unknown> }) {}
  async publish(channel: string, message: string): Promise<void> { await this.publisher.publish(channel, message); }
  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> { await this.subscriber.subscribe(channel, listener); this.subscriptions.set(channel, (this.subscriptions.get(channel) ?? 0) + 1); let active = true; return async () => { if (!active) return; active = false; const remaining = (this.subscriptions.get(channel) ?? 1) - 1; if (remaining <= 0) { this.subscriptions.delete(channel); await this.subscriber.unsubscribe(channel); } else this.subscriptions.set(channel, remaining); }; }
}

/** Optional durable persistence boundary for deployments that need updates to
 * survive process restarts independently of the JSON compatibility store. */
export interface CollaborationPersistence {
  appendUpdate(input: { documentId: string; sequence: number; update: string; bytes: number; createdAt: string }): Promise<void>;
  saveSnapshot(input: { documentId: string; sequence: number; update: string; createdAt: string }): Promise<void>;
  load(documentId: string): Promise<{ snapshots: Array<{ sequence: number; update: string }>; updates: Array<{ sequence: number; update: string }> }>;
}

/** Minimal Redis pub/sub adapter contract. The concrete client is injected so
 * deployments can use ioredis, node-redis, or a managed platform client. */
export interface RedisClientLike {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
}
