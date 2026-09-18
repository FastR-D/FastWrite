import nodemailer, { type Transporter } from "nodemailer";
import type { JsonDatabase } from "../storage/database";

export interface MailTransport {
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

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
      const deliveries = this.database.snapshot().notificationDeliveries
        .filter((delivery) => delivery.status === "pending" && delivery.attempts < 5 && (!delivery.nextAttemptAt || delivery.nextAttemptAt <= new Date().toISOString()))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit);
      for (const delivery of deliveries) await this.deliver(delivery.id);
    } finally {
      this.dispatching = false;
    }
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
      });
    }
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}
