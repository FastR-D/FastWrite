export interface MetricsSnapshot { requests: number; errors: number; status: Record<string, number>; routes: Record<string, number>; startedAt: string; }

export class MetricsRegistry {
  private requests = 0;
  private errors = 0;
  private readonly status = new Map<number, number>();
  private readonly routes = new Map<string, number>();
  readonly startedAt = new Date().toISOString();
  observe(method: string, pathname: string, status: number): void { this.requests++; if (status >= 500) this.errors++; this.status.set(status, (this.status.get(status) ?? 0) + 1); const key = `${method} ${pathname}`; this.routes.set(key, (this.routes.get(key) ?? 0) + 1); }
  snapshot(): MetricsSnapshot { return { requests: this.requests, errors: this.errors, status: Object.fromEntries(this.status), routes: Object.fromEntries(this.routes), startedAt: this.startedAt }; }
  prometheus(): string { const lines = [`# TYPE fastwrite_http_requests_total counter`, `fastwrite_http_requests_total ${this.requests}`, `# TYPE fastwrite_http_errors_total counter`, `fastwrite_http_errors_total ${this.errors}`]; for (const [status, count] of this.status) lines.push(`fastwrite_http_responses_total{status="${status}"} ${count}`); return `${lines.join("\n")}\n`; }
}
