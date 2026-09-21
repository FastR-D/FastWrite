import nodemailer, { type Transporter } from "nodemailer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { JsonDatabase } from "../storage/database";

export interface MailTransport {
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

export type MailWebhookStatus = "delivered" | "bounced" | "complained";

export class SmtpMailTransport implements MailTransport {
  private readonly transport: Transporter;

  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }

  async send(input: { to: string; subject: string; text: string }): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: input.to, subject: input.subject, text: input.text });
  }
}

export class MailDeliveryService {
  private dispatching = false;

  constructor(private readonly database: JsonDatabase, private readonly transport?: MailTransport) {}

  configured(): boolean { return Boolean(this.transport); }

  async dispatchPending(limit = 20): Promise<void> {
    if (!this.transport || this.dispatching) return;
    this.dispatching = true;
    try {
      const now = new Date().toISOString();
      const deliveries = this.database.snapshot().notificationDeliveries
        .filter((delivery) => delivery.status === "pending" && delivery.attempts < 5 && (!delivery.nextAttemptAt || delivery.nextAttemptAt <= now) && (!(delivery as typeof delivery & { leaseExpiresAt?: string }).leaseExpiresAt || (delivery as typeof delivery & { leaseExpiresAt?: string }).leaseExpiresAt! <= now))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit);
      for (const delivery of deliveries) {
        if (await this.claim(delivery.id)) await this.deliver(delivery.id);
      }
    } finally {
      this.dispatching = false;
    }
  }

  /** A standalone process can call this with a stable worker id. Claiming is
   * persisted before SMTP I/O, so multiple workers do not send the same item. */
  async dispatchWorker(workerId: string, limit = 20): Promise<{ claimed: number }> {
    if (!this.transport) return { claimed: 0 };
    let claimed = 0;
    const now = new Date().toISOString();
    const deliveries = this.database.snapshot().notificationDeliveries.filter((item) => item.status === "pending" && (!(item as typeof item & { leaseExpiresAt?: string }).leaseExpiresAt || (item as typeof item & { leaseExpiresAt?: string }).leaseExpiresAt! <= now)).slice(0, limit);
    for (const delivery of deliveries) if (await this.claim(delivery.id, workerId)) { claimed += 1; await this.deliver(delivery.id); }
    return { claimed };
  }

  async handleWebhook(input: { deliveryId?: string; status?: MailWebhookStatus; error?: string; signature?: string; secret?: string; rawBody?: string }): Promise<boolean> {
    if (input.secret) {
      if (!input.signature || !input.rawBody) return false;
      const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
      const provided = input.signature.replace(/^sha256=/, "");
      const expectedBytes = Buffer.from(expected, "utf8");
      const providedBytes = Buffer.from(provided, "utf8");
      if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) return false;
    }
    if (!input.deliveryId || !input.status) return false;
    await this.database.mutate((state) => {
      const delivery = state.notificationDeliveries.find((item) => item.id === input.deliveryId);
      if (!delivery) return;
      const now = new Date().toISOString();
      if (input.status === "delivered") { delivery.status = "sent"; delivery.sentAt ??= now; }
      else { delivery.status = "failed"; delete delivery.nextAttemptAt; }
      const error = input.error?.slice(0, 500) ?? (input.status === "bounced" ? "Recipient mailbox rejected the message" : input.status === "complained" ? "Recipient marked the message as spam" : undefined);
      if (error) delivery.lastError = error;
      delivery.updatedAt = now;
    });
    return true;
  }

  status(): { configured: boolean; pending: number; sent: number; failed: number } {
    const deliveries = this.database.snapshot().notificationDeliveries;
    return { configured: this.configured(), pending: deliveries.filter((item) => item.status === "pending").length, sent: deliveries.filter((item) => item.status === "sent").length, failed: deliveries.filter((item) => item.status === "failed").length };
  }

  async recoverExpiredLeases(now = new Date().toISOString()): Promise<number> {
    return this.database.mutate((state) => {
      let recovered = 0;
      for (const delivery of state.notificationDeliveries) {
        const leased = delivery as typeof delivery & { leaseWorkerId?: string; leaseExpiresAt?: string };
        if (delivery.status === "pending" && leased.leaseExpiresAt && leased.leaseExpiresAt <= now) {
          delete leased.leaseWorkerId; delete leased.leaseExpiresAt; delivery.nextAttemptAt = now; delivery.updatedAt = now; recovered++;
        }
      }
      return recovered;
    });
  }

  private async claim(id: string, _workerId = "inline"): Promise<boolean> {
    return this.database.mutate((state) => {
      const delivery = state.notificationDeliveries.find((item) => item.id === id);
      if (!delivery || delivery.status !== "pending" || delivery.attempts >= 5) return false;
      const now = new Date().toISOString();
      if (delivery.nextAttemptAt && delivery.nextAttemptAt > now) return false;
      delivery.nextAttemptAt = new Date(Date.now() + 10 * 60_000).toISOString();
      (delivery as typeof delivery & { leaseWorkerId?: string; leaseExpiresAt?: string }).leaseWorkerId = _workerId;
      (delivery as typeof delivery & { leaseWorkerId?: string; leaseExpiresAt?: string }).leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      delivery.updatedAt = now;
      return true;
    });
  }

  private async deliver(id: string): Promise<void> {
    const delivery = this.database.snapshot().notificationDeliveries.find((item) => item.id === id);
    if (!delivery || delivery.status !== "pending" || delivery.attempts >= 5 || !this.transport) return;
    try {
      await this.transport.send({ to: delivery.recipientEmail, subject: delivery.subject, text: delivery.text });
      await this.database.mutate((state) => {
        const stored = state.notificationDeliveries.find((item) => item.id === id);
        if (!stored || stored.status !== "pending") return;
        const now = new Date().toISOString();
        stored.attempts += 1; stored.status = "sent"; stored.sentAt = now; stored.updatedAt = now;
        delete (stored as typeof stored & { leaseWorkerId?: string; leaseExpiresAt?: string }).leaseWorkerId;
        delete (stored as typeof stored & { leaseWorkerId?: string; leaseExpiresAt?: string }).leaseExpiresAt;
      });
    } catch (error) {
      await this.database.mutate((state) => {
        const stored = state.notificationDeliveries.find((item) => item.id === id);
        if (!stored || stored.status !== "pending") return;
        stored.attempts += 1;
        stored.status = stored.attempts >= 5 ? "failed" : "pending";
        if (stored.status === "pending") stored.nextAttemptAt = new Date(Date.now() + retryDelayMs(stored.attempts)).toISOString();
        stored.lastError = error instanceof Error ? error.message.slice(0, 500) : "Mail transport failed";
        stored.updatedAt = new Date().toISOString();
        delete (stored as typeof stored & { leaseWorkerId?: string; leaseExpiresAt?: string }).leaseWorkerId;
        delete (stored as typeof stored & { leaseWorkerId?: string; leaseExpiresAt?: string }).leaseExpiresAt;
      });
    }
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}
