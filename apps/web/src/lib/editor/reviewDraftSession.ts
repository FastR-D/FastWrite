import { mergeReviewDraft } from "@fastwrite/shared";
import type { CollaborationReviewSessionView } from "@fastwrite/shared";

export interface ReviewDraftRecord { session: CollaborationReviewSessionView; content: string; pending?: { content: string; expectedRevision: number; operationId: string }; }
export interface ReviewDraftPort {
  start(previousId?: string): Promise<CollaborationReviewSessionView>;
  read?(id: string): Promise<CollaborationReviewSessionView>;
  save(id: string, input: { draftContent: string; expectedRevision: number; operationId: string }): Promise<CollaborationReviewSessionView>;
  load(): Promise<ReviewDraftRecord | undefined>;
  store(record: ReviewDraftRecord): Promise<void>;
  archive(record: ReviewDraftRecord): Promise<void>;
}

/** An isolated review buffer: autosaves proposals, never the accepted document. */
export class ReviewDraftSession {
  session: CollaborationReviewSessionView | undefined;
  content = "";
  state: "loading" | "saved" | "dirty" | "saving" | "offline" | "conflict" = "loading";
  error: unknown = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private localWrites: Promise<void> = Promise.resolve();
  private running: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private readyPromise: Promise<void> | undefined;
  private pending: ReviewDraftRecord["pending"];
  private disposed = false;
  constructor(private readonly port: ReviewDraftPort, private readonly saved: () => void, private readonly debounceMs = 850) {}
  get dirty() { return !!this.session && this.content !== this.session.draftContent; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { if (!this.disposed) for (const listener of this.listeners) listener(); }
  ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.initialize().catch(error => { this.error = error; this.state = "conflict"; this.readyPromise = undefined; this.emit(); throw error; });
    return this.readyPromise;
  }
  private async initialize() {
    const cached = await this.port.load();
    if (cached) { this.session = cached.session; this.content = cached.content; this.pending = cached.pending; this.state = "offline"; this.emit(); }
    let server: CollaborationReviewSessionView;
    try { server = await this.port.start(); }
    catch (error) { if (cached) { this.error = error; this.emit(); return; } throw error; }
    if (cached && cached.session.id === server.id) {
      const acknowledged = !!cached.pending && (cached.pending.operationId === server.lastOperationId || !!server.recentOperations?.some(item => item.id === cached.pending!.operationId));
      if (cached.session.revision !== server.revision && cached.content !== cached.session.draftContent && cached.content !== server.draftContent && !acknowledged) {
        this.error = new Error("另一窗口更新了修订草稿，本地输入已保留。可保存副本并开始下一轮。"); this.state = "conflict"; this.emit(); return;
      }
      if (acknowledged && cached.pending) {
        const merged = mergeReviewDraft(cached.pending.content, cached.content, server.draftContent);
        if (merged.conflict) { this.error = new Error("恢复草稿时遇到重叠更改，本地输入已保留。"); this.state = "conflict"; this.emit(); return; }
        this.content = merged.content; this.pending = undefined;
      } else if (cached.content === cached.session.draftContent) this.content = server.draftContent;
      this.session = server;
    } else {
      if (cached && cached.content !== cached.session.draftContent) await this.port.archive(cached);
      this.session = server; this.content = server.draftContent; this.pending = undefined;
    }
    this.state = this.dirty ? "dirty" : "saved"; this.error = null; await this.cache(); this.emit();
    if (this.dirty) this.schedule();
  }
  edit(content: string) {
    if (!this.session || content === this.content) return;
    this.content = content;
    if (this.state !== "conflict") { this.state = "dirty"; this.error = null; this.schedule(); }
    void this.cache().catch(error => { this.error = error; this.emit(); });
    this.emit();
  }
  private schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, this.debounceMs); }
  private cache() {
    if (!this.session) return Promise.resolve();
    const record: ReviewDraftRecord = { session: structuredClone(this.session), content: this.content, ...(this.pending ? { pending: { ...this.pending } } : {}) };
    this.localWrites = this.localWrites.catch(() => undefined).then(() => this.port.store(record));
    return this.localWrites;
  }
  async flush(): Promise<void> {
    await this.ready();
    if (this.refreshing) await this.refreshing;
    clearTimeout(this.timer);
    if (this.state === "conflict") throw this.error;
    if (this.running) { await this.running; if (this.dirty) return this.flush(); return; }
    this.running = this.drain();
    try { await this.running; } finally { this.running = undefined; }
  }
  private async drain() {
    try {
      while (this.dirty || this.pending) {
        if (!this.session) return;
        this.pending ??= { content: this.content, expectedRevision: this.session.revision, operationId: crypto.randomUUID() };
        await this.cache(); this.state = "saving"; this.emit();
        const pending = this.pending;
        const result = await this.port.save(this.session.id, { draftContent: pending.content, expectedRevision: pending.expectedRevision, operationId: pending.operationId });
        const merged = mergeReviewDraft(pending.content, this.content, result.draftContent);
        this.session = result; this.pending = undefined;
        if (merged.conflict) { const error = Object.assign(new Error("合作者的正文更改与正在输入的修订重叠，本地输入已保留，请核对后开始下一轮。"), { status: 409 }); throw error; }
        this.content = merged.content;
        await this.cache(); this.saved(); this.emit();
      }
      this.state = "saved"; this.error = null; this.emit();
    } catch (error) {
      this.error = error;
      this.state = (error as { status?: number })?.status === 409 || (error as { status?: number })?.status === 403 ? "conflict" : "offline";
      await this.cache(); this.emit(); throw error;
    }
  }
  async refresh() {
    await this.ready();
    if (!this.port.read || !this.session || this.dirty || this.pending || this.running || this.refreshing || this.state === "conflict") return;
    const baseline = this.session.draftContent, id = this.session.id;
    this.refreshing = (async () => {
      const result = await this.port.read!(id);
      if (this.session?.id !== id) return;
      const merged = mergeReviewDraft(baseline, this.content, result.draftContent);
      if (merged.conflict) { this.error = new Error("正文与当前输入发生重叠，本地修订已保留。请核对后开始下一轮。"); this.state = "conflict"; this.emit(); return; }
      if (this.session.revision === result.revision && this.session.closedAt === result.closedAt && this.content === merged.content) return;
      this.session = result; this.content = merged.content; this.error = null; this.state = this.dirty ? "dirty" : "saved";
      await this.cache(); this.emit(); if (this.dirty) this.schedule();
    })();
    try { await this.refreshing; } catch (error) { this.error = error; this.emit(); } finally { this.refreshing = undefined; }
  }

  async nextRound() {
    await this.ready();
    if (this.running) await this.running.catch(() => undefined);
    if (this.refreshing) await this.refreshing;
    clearTimeout(this.timer);
    if (this.session) await this.port.archive({ session: this.session, content: this.content, ...(this.pending ? { pending: this.pending } : {}) });
    let next: CollaborationReviewSessionView;
    try { next = await this.port.start(this.session?.id); } catch (error) { this.error = error; this.emit(); throw error; }
    this.session = next; this.content = next.draftContent; this.pending = undefined; this.error = null; this.state = "saved";
    await this.cache(); this.emit(); this.saved();
  }
  async dispose() { clearTimeout(this.timer); await this.cache(); this.disposed = true; this.listeners.clear(); }
}
