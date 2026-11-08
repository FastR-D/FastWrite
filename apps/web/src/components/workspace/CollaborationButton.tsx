import { userFacingError } from "../../lib/notifications";
import { useEffect, useState } from "react";
import type { DocumentRegistry } from "../../lib/editor/documentRegistry";
import { Button, Icon, icons } from "../ui";

export function CollaborationButton({ registry, path }: { registry: DocumentRegistry; path: string | null }) {
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    refresh(value => value + 1);
    return registry.subscribe(entry => {
      if (entry.session.path === path) refresh(value => value + 1);
    });
  }, [registry, path]);

  const entry = path ? registry.get(path) : undefined;
  const enabled = entry?.mode === "collaboration";
  const provider = entry?.collaboration;
  const peers = provider?.peers().length ?? 0;
  const states = { initializing: "正在初始化", cached: "已缓存", connecting: "正在连接", synced: "已连接", persisted: "已写入文件", offline: "离线，已保留本地更改", conflict: "同步冲突" };
  const status = error || (provider?.error ? userFacingError(provider.error) : "") || (enabled ? states[provider?.state ?? "initializing"] : "协作同步当前文件");
  const toggle = async () => {
    if (!entry || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!enabled) await registry.enableCollaboration(entry).ready();
      else await provider?.reconnect();
    } catch (failure) {
      setError(userFacingError(failure, "无法连接协作"));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button size="small" variant="secondary" icon={<Icon name={icons.personAdd} />} aria-pressed={enabled} disabled={!entry?.access?.realtime || busy} loading={busy} title={status} onClick={() => { void toggle(); }}>
      {enabled ? (provider?.state === "offline" ? "协作离线" : provider?.state === "conflict" ? "协作需重连" : "协作已开启") : "连接协作"}{peers ? ` · ${peers}` : ""}
    </Button>
    {error ? <span role="alert">{error}</span> : null}
  </>;
}
