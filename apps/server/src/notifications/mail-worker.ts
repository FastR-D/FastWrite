import { config } from "../config";
import { JsonDatabase } from "../storage/database";
import { MailDeliveryService, SmtpMailTransport } from "./mail-delivery-service";

export async function runMailWorker(options: { pollMs?: number } = {}): Promise<void> {
  if (!config.mail) throw new Error("FASTWRITE_SMTP_URL and FASTWRITE_MAIL_FROM are required");
  const database = new JsonDatabase(config.dataDirectory); await database.initialize();
  const service = new MailDeliveryService(database, new SmtpMailTransport(config.mail.smtpUrl, config.mail.from));
  const workerId = `mail_${process.pid}_${crypto.randomUUID()}`;
  const pollMs = Math.min(Math.max(options.pollMs ?? 5_000, 500), 60_000);
  let stopped = false; const stop = () => { stopped = true; }; process.once("SIGTERM", stop); process.once("SIGINT", stop);
  while (!stopped) { await service.recoverExpiredLeases(); await service.dispatchWorker(workerId, 50); await new Promise((resolve) => setTimeout(resolve, pollMs)); }
}

if (import.meta.main) await runMailWorker();
