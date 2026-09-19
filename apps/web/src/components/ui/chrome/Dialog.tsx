import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { IconButton } from "../primitives/IconButton";
import { Icon } from "../primitives/Icon";
import { icons } from "../icons";
import styles from "./Dialog.module.css";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  width?: "small" | "medium" | "large" | "wide" | "fullscreen";
  className?: string;
  resizable?: boolean;
  onClose: () => void;
}

/*
 * The stable global class names (`dialog`, `dialog--{width}`, `dialog__header`)
 * are deliberate, not vestigial. Two consumers restyle the dialog from page CSS
 * — `.dialog--wide.review-dialog` and `.dialog--fullscreen .draft-diff` in
 * styles.css — and CSS-module hashing would make those selectors unreachable.
 * They are the migration's transitional seam; Phase 5 removes them once those
 * consumers own their own styling.
 */
export function Dialog({ open, title, description, children, footer, headerActions, width = "medium", className = "", resizable = false, onClose }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [resizedWidth, setResizedWidth] = useState(() => Number.parseInt(localStorage.getItem("fastwrite.review-width") ?? "", 10) || 800);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => !element.hasAttribute("hidden"));
    const frame = requestAnimationFrame(() => {
      if (!dialogRef.current?.contains(document.activeElement)) (dialogRef.current?.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0])?.focus();
    });
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") onCloseRef.current();
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", listener);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", listener);
      previouslyFocused?.focus();
    };
  }, [open]);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const updateWidth = (next: number) => {
    const value = Math.round(Math.min(Math.max(560, next), Math.max(560, window.innerWidth - 32)));
    setResizedWidth(value);
    localStorage.setItem("fastwrite.review-width", String(value));
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const onMove = (moveEvent: PointerEvent) => updateWidth(Math.abs(moveEvent.clientX - window.innerWidth / 2) * 2);
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", cleanup, { once: true });
  };
  if (!open) return null;
  /*
   * `styles[width]` is undefined for "medium" — the default width lives on
   * `.dialog` and has no variant rule. Falling back to "" keeps the class
   * string clean; without it the element would render class="undefined".
   */
  const widthClass = styles[width] ?? "";

  return (
    <div className={`${styles.backdrop} dialog-backdrop`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={`${styles.dialog} ${widthClass} dialog dialog--${width} ${className}`} style={resizable ? { width: `min(${resizedWidth}px, calc(100vw - 32px))` } : undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
        <header className={`${styles.header} dialog__header`}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <div className={`${styles.headerActions} dialog__header-actions`}>{headerActions}<IconButton label="Close dialog" icon={<Icon name={icons.close} />} onClick={onClose} /></div>
        </header>
        <div className={`${styles.body} dialog__body`}>{children}</div>
        {footer ? <footer className={`${styles.footer} dialog__footer`}>{footer}</footer> : null}
        {resizable ? <div className={`${styles.widthHandle} dialog__width-handle`} role="separator" aria-label={`Resize ${title} window`} aria-orientation="vertical" aria-valuemin={Math.min(560, Math.max(0, window.innerWidth - 32))} aria-valuemax={Math.max(0, window.innerWidth - 32)} aria-valuenow={Math.min(resizedWidth, Math.max(0, window.innerWidth - 32))} tabIndex={0} onPointerDown={startResize} onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); updateWidth(resizedWidth - 40); }
          else if (event.key === "ArrowRight") { event.preventDefault(); updateWidth(resizedWidth + 40); }
          else if (event.key === "Home") { event.preventDefault(); updateWidth(560); }
          else if (event.key === "End") { event.preventDefault(); updateWidth(window.innerWidth - 32); }
        }}><Icon name={icons.gripper} /></div> : null}
      </section>
    </div>
  );
}
