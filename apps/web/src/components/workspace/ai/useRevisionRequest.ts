import { useCallback, useEffect, useRef } from "react";

/** Invalidates completed responses as well as aborting requests still in flight. */
export function useRevisionRequest() {
  const active = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const begin = useCallback(() => {
    cancel();
    const controller = new AbortController();
    active.current = controller;
    return {
      signal: controller.signal,
      isCurrent: () => active.current === controller && !controller.signal.aborted,
      finish: () => { if (active.current === controller) active.current = null; }
    };
  }, [cancel]);

  return { begin, cancel };
}
