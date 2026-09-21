import { expect, test } from "bun:test";
import { JsonDatabase } from "../storage/database";
import { MailDeliveryService, type MailTransport } from "./mail-delivery-service";
import { createHmac } from "node:crypto";

test("recovers expired mail leases and sends a delivery once", async () => {
  const database = new JsonDatabase(`/tmp/fastwrite-mail-${crypto.randomUUID()}`); await database.initialize();
  const sent: string[] = [];
  const transport: MailTransport = { send: async ({ to }) => { sent.push(to); } };
  await database.mutate((state) => { state.notificationDeliveries.push({ id: "delivery_1", notificationId: "notification_1", userId: "user_1", channel: "email", status: "pending", attempts: 0, recipientEmail: "author@example.test", subject: "Test", text: "Hello", nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...({ leaseWorkerId: "dead", leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() } as any) }); });
  const service = new MailDeliveryService(database, transport);
  expect(await service.recoverExpiredLeases()).toBe(1);
  await service.dispatchWorker("worker", 10);
  expect(sent).toEqual(["author@example.test"]);
  expect(database.snapshot().notificationDeliveries[0]).toMatchObject({ status: "sent", attempts: 1 });
});

test("accepts signed webhooks and rejects invalid signatures", async () => {
  const database = new JsonDatabase(`/tmp/fastwrite-mail-${crypto.randomUUID()}`); await database.initialize();
  await database.mutate((state) => { state.notificationDeliveries.push({ id: "delivery_signed", notificationId: "notification_1", userId: "user_1", channel: "email", status: "pending", attempts: 0, recipientEmail: "author@example.test", subject: "Test", text: "Hello", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  const service = new MailDeliveryService(database);
  const rawBody = JSON.stringify({ deliveryId: "delivery_signed", status: "delivered" });
  expect(await service.handleWebhook({ ...JSON.parse(rawBody), rawBody, secret: "secret", signature: "bad" })).toBe(false);
  expect(database.snapshot().notificationDeliveries[0]!.status).toBe("pending");
  const signature = createHmac("sha256", "secret").update(rawBody).digest("hex");
  expect(await service.handleWebhook({ ...JSON.parse(rawBody), rawBody, secret: "secret", signature: `sha256=${signature}` })).toBe(true);
  expect(database.snapshot().notificationDeliveries[0]!.status).toBe("sent");
});
