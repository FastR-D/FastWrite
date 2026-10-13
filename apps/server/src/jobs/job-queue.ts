export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface JobProgress { completed: number; total?: number; message?: string; }
export interface JobRecord<T = unknown> { id: string; kind: string; status: JobStatus; attempts: number; maxAttempts: number; input?: T; output?: unknown; error?: string; deadLetter?: boolean; progress?: JobProgress; policy?: JobPolicy; lease?: { workerId: string; expiresAt: string }; createdAt: string; updatedAt: string; }
export interface JobPolicy { actorUserId?: string; projectId?: string; projectVersion?: number; authorizationVersion?: number; action?: string; paths?: string[]; }
export interface JobHandlerContext { input: unknown; job: JobRecord; recheck?: () => Promise<void>; }
export interface JobStore {
  load(): JobRecord[];
  save(job: JobRecord): Promise<void>;
  remove?(id: string): Promise<void>;
}

export class InProcessJobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly work = new Map<string, Promise<void>>();
  private readonly store: JobStore | undefined;
  private readonly limits: { total: number; byKind: Map<string, number> };
  constructor(options: { store?: JobStore; restore?: boolean; limits?: { total?: number; byKind?: Record<string, number> } } = {}) {
    this.store = options.store;
    this.limits = { total: Math.max(1, options.limits?.total ?? Number.POSITIVE_INFINITY), byKind: new Map(Object.entries(options.limits?.byKind ?? {}).map(([kind, limit]) => [kind, Math.max(1, Math.floor(limit))])) };
    if (options.restore !== false) for (const job of options.store?.load() ?? []) {
      if (job.status === "running") { job.status = "queued"; job.updatedAt = new Date().toISOString(); }
      this.jobs.set(job.id, structuredClone(job));
    }
  }
  enqueue<T>(kind: string, input: T, handler: (input: T, job: JobRecord<T>, signal: AbortSignal) => Promise<unknown>, options: { maxAttempts?: number; start?: boolean; policy?: JobPolicy; beforeWrite?: (job: JobRecord<T>) => Promise<void>; recheck?: (job: JobRecord<T>) => Promise<void> } = {}): JobRecord<T> {
    const active = [...this.jobs.values()].filter((job) => ["queued", "running"].includes(job.status));
    const kindLimit = this.limits.byKind.get(kind);
    if (active.length >= this.limits.total || (kindLimit !== undefined && active.filter((job) => job.kind === kind).length >= kindLimit)) throw new Error("job_quota_exceeded");
    const now = new Date().toISOString();
    const job: JobRecord<T> = { id: `job_${crypto.randomUUID()}`, kind, status: "queued", attempts: 0, maxAttempts: Math.min(Math.max(options.maxAttempts ?? 2, 1), 5), input, ...(options.policy ? { policy: structuredClone(options.policy) } : {}), createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    void this.persist(job).catch(() => undefined);
    if (options.start !== false) this.launch(job, async signal => {
      await options.beforeWrite?.(job); signal.throwIfAborted();
      await options.recheck?.(job); signal.throwIfAborted();
      return handler(input, job, signal);
    });
    return structuredClone(job);
  }
  get(id: string): JobRecord | undefined { const job = this.jobs.get(id); return job ? structuredClone(job) : undefined; }
  list(kind?: string): JobRecord[] { return [...this.jobs.values()].filter((job) => !kind || job.kind === kind).map((job) => structuredClone(job)); }
  deadLetters(kind?: string): JobRecord[] { return this.list(kind).filter((job) => job.deadLetter === true); }
  updateProgress(id: string, progress: JobProgress): JobRecord { const job = this.jobs.get(id); if (!job) throw new Error("Job not found"); if (!["queued", "running"].includes(job.status)) throw new Error("Job is not active"); const completed = Math.max(0, Math.floor(progress.completed)); const total = progress.total === undefined ? undefined : Math.max(completed, Math.floor(progress.total)); job.progress = { completed, ...(total === undefined ? {} : { total }), ...(progress.message ? { message: String(progress.message).slice(0, 500) } : {}) }; job.updatedAt = new Date().toISOString(); void this.persist(job).catch(() => undefined); return structuredClone(job); }
  cancel(id: string): JobRecord { const job = this.jobs.get(id); if (!job) throw new Error("Job not found"); if (job.status === "queued" || job.status === "running") { job.status = "cancelled"; this.controllers.get(id)?.abort(); delete job.lease; job.updatedAt = new Date().toISOString(); void this.persist(job).catch(() => undefined); } return structuredClone(job); }
  prune(maxAgeMs = 60 * 60 * 1000): number { const cutoff = Date.now() - maxAgeMs; let removed = 0; for (const [id, job] of this.jobs) if (["completed", "failed", "cancelled"].includes(job.status) && Date.parse(job.updatedAt) < cutoff && !this.work.has(id)) { this.jobs.delete(id); void this.store?.remove?.(id); removed++; } return removed; }
  start(id: string, handler: (input: unknown, job: JobRecord, signal: AbortSignal) => Promise<unknown>): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Job not found");
    if (job.status === "queued" && !this.work.has(id)) this.launch(job, signal => handler(job.input, job, signal));
    return structuredClone(job);
  }
  private launch(job: JobRecord, handler: (signal: AbortSignal) => Promise<unknown>): void {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const run = async () => {
      while (job.attempts < job.maxAttempts && !controller.signal.aborted) {
        job.status = "running"; job.attempts++; job.updatedAt = new Date().toISOString();
        await this.persist(job);
        try {
          controller.signal.throwIfAborted();
          const output = await handler(controller.signal);
          if (controller.signal.aborted) return;
          job.output = output; job.status = "completed"; job.updatedAt = new Date().toISOString();
          await this.persist(job); return;
        } catch (error) {
          if (controller.signal.aborted) return;
          job.error = error instanceof Error ? error.message : "Job failed";
          job.deadLetter = job.attempts >= job.maxAttempts;
          job.status = job.deadLetter ? "failed" : "queued"; job.updatedAt = new Date().toISOString();
          await this.persist(job);
        }
      }
    };
    const promise = run().catch(error => {
      if (!controller.signal.aborted) { job.status = "failed"; job.error = error instanceof Error ? error.message : "Job persistence failed"; job.updatedAt = new Date().toISOString(); }
    }).finally(() => { this.work.delete(job.id); this.controllers.delete(job.id); });
    this.work.set(job.id, promise);
  }
  async settled(id: string): Promise<void> { await this.work.get(id); }
  claim(workerId: string, leaseMs = 30_000): JobRecord | undefined {
    const now = Date.now();
    const candidate = [...this.jobs.values()].find((job) => job.status === "queued" && (!job.lease || Date.parse(job.lease.expiresAt) <= now));
    if (!candidate) return undefined;
    candidate.status = "running";
    candidate.attempts += 1;
    candidate.lease = { workerId, expiresAt: new Date(now + Math.max(1_000, leaseMs)).toISOString() };
    candidate.updatedAt = new Date(now).toISOString();
    void this.persist(candidate).catch(() => undefined);
    return structuredClone(candidate);
  }
  requeueExpiredLeases(now = Date.now()): number { let count = 0; for (const job of this.jobs.values()) if (job.status === "running" && job.lease && Date.parse(job.lease.expiresAt) <= now) { delete job.lease; job.status = job.attempts >= job.maxAttempts ? "failed" : "queued"; job.deadLetter = job.status === "failed"; job.error = "worker_lease_expired"; job.updatedAt = new Date(now).toISOString(); void this.persist(job).catch(() => undefined); count++; } return count; }
  async finishClaim(id: string, workerId: string, result: { output?: unknown; error?: string }): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || job.lease?.workerId !== workerId) throw new Error("Job lease is not owned by this worker");
    if (result.error) { job.error = result.error; job.deadLetter = job.attempts >= job.maxAttempts; job.status = job.deadLetter ? "failed" : "queued"; }
    else { job.output = result.output; job.status = "completed"; }
    delete job.lease;
    job.updatedAt = new Date().toISOString();
    await this.persist(job).catch(() => undefined);
    return structuredClone(job);
  }
  private async persist(job: JobRecord): Promise<void> { if (!this.store) return; const copy = structuredClone(job); if (copy.output !== undefined) { const serialized = JSON.stringify(copy.output); if (serialized.length > 250_000) { copy.output = { truncated: true, bytes: serialized.length }; } } await this.store.save(copy); }
}
