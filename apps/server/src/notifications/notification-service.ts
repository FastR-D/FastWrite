import type { UserNotification, UserNotificationType } from "@fastwrite/shared";
import type { DatabaseState } from "../storage/database";

export function createNotification(
  state: DatabaseState,
  input: { userId: string; type: UserNotificationType; title: string; body?: string; projectId?: string; accessRequestId?: string }
): UserNotification {
  const now = new Date().toISOString();
  const preference = state.notificationPreferences.find((item) => item.userId === input.userId && item.type === input.type);
  const notification: UserNotification = {
    id: `notification_${crypto.randomUUID()}`,
    ...input,
    inApp: preference?.inApp ?? true,
    createdAt: now
  };
  state.notifications.push(notification);
  if (preference?.email) {
    const recipient = state.users.find((user) => user.id === input.userId)?.emailNormalized;
    if (recipient) {
      state.notificationDeliveries.push({
        id: `delivery_${crypto.randomUUID()}`,
        notificationId: notification.id,
        userId: input.userId,
        channel: "email",
        status: "pending",
        attempts: 0,
        recipientEmail: recipient,
        subject: `FastWrite: ${input.title}`,
        text: "You have a new FastWrite notification. Sign in to view it.",
        createdAt: now,
        updatedAt: now
      });
    }
  }
  return notification;
}

export function notificationPreferences(state: DatabaseState, userId: string) {
  const types: UserNotificationType[] = ["access_request", "access_request_decision", "mention"];
  return types.map((type) => state.notificationPreferences.find((item) => item.userId === userId && item.type === type) ?? { userId, type, inApp: true, email: false, updatedAt: "" });
}
