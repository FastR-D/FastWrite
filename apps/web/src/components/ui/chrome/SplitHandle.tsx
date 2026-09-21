import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import styles from "./SplitHandle.module.css";

export interface SplitHandleProps {
  /** Accessible name, e.g. "Resize files panel". Required. */
  label: string;
  orientation?: "vertical" | "horizontal";
  /** Current position in pixels, for aria-valuenow. */
  value: number;
  min: number;
  max: number;
  /** Highlight while the drag is in progress. */
  active?: boolean;
  /**
   * Flip the arrow-key direction. A handle on the right edge of the thing it
   * resizes grows the panel when dragged left, so its arrows must invert or
   * they move the divider the wrong way.
   */
  reverse?: boolean;
  /** Keyboard step in pixels. */
  step?: number;
  onPointerDown: () => void;
  onKeyboardChange: (value: number) => void;
  className?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A draggable divider between two panes.
 *
 * The pointer drag itself is owned by the caller — it has to track document
 * pointermove and pointerup to keep working when the cursor leaves the handle,
 * and it knows which panel it is resizing. This component owns the keyboard
 * path and the ARIA, which are self-contained: arrows, Home and End, with the
 * value clamped and announced through aria-valuenow.
 */
export function SplitHandle({
  label, orientation = "vertical", value, min, max, active = false, reverse = false, step = 16,
  onPointerDown, onKeyboardChange, className = ""
}: SplitHandleProps) {
  const decreaseKey = orientation === "horizontal" ? "ArrowDown" : "ArrowLeft";
  const increaseKey = orientation === "horizontal" ? "ArrowUp" : "ArrowRight";
  const direction = reverse ? -1 : 1;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === decreaseKey) { event.preventDefault(); onKeyboardChange(clamp(value - step * direction, min, max)); }
    else if (event.key === increaseKey) { event.preventDefault(); onKeyboardChange(clamp(value + step * direction, min, max)); }
    else if (event.key === "Home") { event.preventDefault(); onKeyboardChange(min); }
    else if (event.key === "End") { event.preventDefault(); onKeyboardChange(max); }
  };

  return (
    <div
      className={`${styles.handle} ${styles[orientation]} ${active ? styles.active : ""} ${className}`.trim()}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); onPointerDown(); }}
    >
      <span />
    </div>
  );
}
