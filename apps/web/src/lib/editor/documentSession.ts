/** A document's save lifetime is independent of the visible editor. */
export class DocumentSession {
  readonly key: string;
  content: string;
  baseContent: string;
  serverVersion: number;
  localRevision = 0;
  ackedRevision = 0;
  error: unknown = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private waiters: Array<{ revision: number; resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(
    readonly projectId: string,
    readonly path: string,
    content: string,
    version: number,
    private readonly persist: (snapshot: { content: string; baseVersion: number; revision: number }) => Promise<{ version: number }>,
    private readonly debounceMs = 850,
  ) {
    this.key = JSON.stringify([projectId, path]);
    this.content = this.baseContent = content;
    this.serverVersion = version;
  }

  get dirty() { return this.localRevision !== this.ackedRevision; }
  get saving() { return this.running; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(); }

  edit(content: string) {
    if (content === this.content) return;
    this.content = content;
    this.localRevision += 1;
    this.error = null;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, this.debounceMs);
    this.emit();
  }

  /** Resolves for the revision at invocation, even if typing continues. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return Promise.resolve();
    const promise = new Promise<void>((resolve, reject) => this.waiters.push({ revision: this.localRevision, resolve, reject }));
    void this.drain();
    return promise;
  }

  /** Accept explicit server invalidation only when it cannot overwrite local work. */
  receive(content: string, version: number): boolean {
    if (version <= this.serverVersion) return false;
    if (this.dirty || this.running) {
      this.error = new Error("服务端版本在本地编辑期间发生了更改，请先比较再替换。");
      this.emit();
      return false;
    }
    this.content = this.baseContent = content;
    this.serverVersion = version;
    this.emit();
    return true;
  }

  /** User-reviewed resolution rebases the next conditional save; it is not an ACK. */
  resolveConflict(content: string, serverContent: string, serverVersion: number, expectedRevision: number) {
    if (this.running) throw new Error("仍有保存操作正在进行，请等待完成后再应用对比结果。");
    if (this.localRevision !== expectedRevision) throw new Error("比较期间本地文本发生了更改，请重新打开对比后再应用。");
    if (serverVersion < this.serverVersion) throw new Error("此对比早于最近一次确认的版本。");
    clearTimeout(this.timer); this.timer = undefined;
    this.serverVersion = serverVersion;
    this.baseContent = serverContent;
    this.content = content;
    this.localRevision++;
    this.error = null;
    this.emit();
  }

  private async drain() {
    if (this.running || !this.dirty) return;
    this.running = true;
    this.error = null;
    this.emit();
    try {
      while (this.dirty) {
        const snapshot = { content: this.content, revision: this.localRevision, baseVersion: this.serverVersion };
        const ack = await this.persist(snapshot);
        this.serverVersion = ack.version;
        this.baseContent = snapshot.content;
        this.ackedRevision = snapshot.revision;
        // Never write ACK text into the working buffer.
        const resolved = this.waiters.filter((waiter) => waiter.revision <= this.ackedRevision);
        this.waiters = this.waiters.filter((waiter) => waiter.revision > this.ackedRevision);
        for (const waiter of resolved) waiter.resolve();
        this.emit();
      }
    } catch (error) {
      this.error = error;
      // Stop automatic retry; preserve the newest buffer for explicit retry.
      clearTimeout(this.timer);
      this.timer = undefined;
      const failed = this.waiters.splice(0);
      for (const waiter of failed) waiter.reject(error);
    } finally {
      this.running = false;
      this.emit();
    }
  }
}
