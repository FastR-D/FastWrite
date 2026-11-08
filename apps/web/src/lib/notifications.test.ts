import { expect, test } from "bun:test";
import { dismissNotification, notificationSnapshot, notifyNetworkFailure, subscribeNotifications, userFacingError } from "./notifications";
import { canUseOfflineCache } from "./offlineWorkspace";

test("network failures become one dismissible notification and retain their offline recovery identity", () => {
  let changes = 0; const unsubscribe = subscribeNotifications(() => { changes++; });
  const failure = new TypeError("Failed to fetch");
  notifyNetworkFailure();
  expect(userFacingError(failure)).toBe("");
  expect(canUseOfflineCache(failure)).toBe(true);
  expect(failure.message).toBe("Failed to fetch");
  expect(notificationSnapshot()).toHaveLength(1);
  expect(notificationSnapshot()[0]?.title).toBe("无法连接到服务器");
  notifyNetworkFailure(); expect(notificationSnapshot()).toHaveLength(1); expect(changes).toBe(1);
  expect(userFacingError(new Error("版本已更新"))).toBe("版本已更新");
  expect(userFacingError(undefined, "请重试")).toBe("请重试");
  dismissNotification(notificationSnapshot()[0]!.id); expect(notificationSnapshot()).toHaveLength(0);
  notifyNetworkFailure(); expect(notificationSnapshot()).toHaveLength(0);
  unsubscribe();
});
