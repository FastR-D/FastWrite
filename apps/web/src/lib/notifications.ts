export interface WorkbenchNotification { id: string; title: string; message: string; }
let notifications: WorkbenchNotification[] = [];
const listeners = new Set<() => void>();
const dismissed = new Map<string, number>();
const emit = () => { for (const listener of listeners) listener(); };
export const notificationSnapshot = () => notifications;
export function subscribeNotifications(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function dismissNotification(id: string) { dismissed.set(id, Date.now()); notifications = notifications.filter(item => item.id !== id); emit(); }
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load failed|connection/i.test(error.message) || error instanceof Error && /failed to fetch|network request failed|load failed/i.test(error.message) || error instanceof DOMException && error.name === "NetworkError";
}
export function notifyNetworkFailure() {
  const id = "network-connection";
  if (notifications.some(item => item.id === id) || Date.now() - (dismissed.get(id) ?? 0) < 60_000) return;
  notifications = [...notifications.slice(-2), { id, title: "无法连接到服务器", message: "请检查网络连接及服务状态，然后重试。" }]; emit();
}
/** Network failures use the notification center; validation and conflict messages stay with their controls. */
export function userFacingError(error: unknown, fallback = "操作失败，请重试"): string {
  if (isNetworkFailure(error)) return "";
  return error instanceof Error ? error.message : fallback;
}
