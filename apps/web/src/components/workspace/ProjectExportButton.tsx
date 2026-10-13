import { useEffect, useRef, useState } from "react";
import { downloadProjectArchive, projectExportErrorMessage } from "../../lib/projectExport";
import { Button, type ButtonProps } from "../ui/primitives/Button";
import { Icon } from "../ui/primitives/Icon";
import { icons } from "../ui/icons";

interface ProjectExportButtonProps extends Omit<ButtonProps, "onClick" | "loading" | "onError"> {
  projectId: string;
  beforeExport?: () => Promise<void>;
  onError?: (message: string) => void;
  onExported?: () => void;
}

export function ProjectExportButton({ projectId, beforeExport, onError, onExported, children = "Export source", icon = <Icon name={icons.cloudDownload} />, ...props }: ProjectExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setError("");
    return () => controller.current?.abort();
  }, [projectId]);

  const download = async () => {
    if (controller.current) return;
    const pending = new AbortController();
    controller.current = pending;
    setError("");
    onError?.("");
    setBusy(true);
    try {
      await beforeExport?.();
      pending.signal.throwIfAborted();
      await downloadProjectArchive(projectId, pending.signal);
      if (!pending.signal.aborted) onExported?.();
    } catch (failure) {
      if (!pending.signal.aborted) {
        const message = projectExportErrorMessage(failure);
        setError(message);
        onError?.(message);
      }
    } finally {
      if (controller.current === pending) {
        controller.current = null;
        if (!pending.signal.aborted) setBusy(false);
      }
    }
  };

  return <>
    <Button {...props} icon={icon} loading={busy} aria-busy={busy} onClick={() => void download()}>{busy ? "Preparing export…" : children}</Button>
    {!onError && error ? <span className="form-error" role="alert">{error}</span> : null}
  </>;
}
