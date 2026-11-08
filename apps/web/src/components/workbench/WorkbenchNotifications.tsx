import { useSyncExternalStore } from "react";
import { dismissNotification, notificationSnapshot, subscribeNotifications } from "../../lib/notifications";
import { Icon, IconButton, icons } from "../ui";
import styles from "./WorkbenchNotifications.module.css";

export function WorkbenchNotifications() {
  const notifications = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  return <aside className={styles.stack} aria-label="工作区通知">{notifications.map(item => <section className={styles.notification} role="alert" key={item.id}>
    <Icon name={icons.error} /><div><strong>{item.title}</strong><p>{item.message}</p></div><IconButton label="关闭通知" icon={<Icon name={icons.close} />} onClick={() => dismissNotification(item.id)} />
  </section>)}</aside>;
}
