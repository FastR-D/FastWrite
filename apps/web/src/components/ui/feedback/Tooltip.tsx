import { cloneElement, useCallback, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import styles from "./Tooltip.module.css";

export interface TooltipProps {
  /** Tooltip text. */
  content: string;
  /** A single focusable element. Receives aria-describedby. */
  children: ReactElement<{ "aria-describedby"?: string }>;
  /** Preferred side. Flips automatically when there is no room. */
  side?: "top" | "bottom";
  /** Delay before showing, in ms. Keyboard focus shows immediately. */
  delay?: number;
}

/** Gap between the tooltip and its trigger. */
const GAP = 8;
/** Vertical room a side needs before it counts as usable. */
const FLIP_ROOM = 44;
/** Minimum distance the tooltip keeps from a viewport edge. */
const EDGE_MARGIN = 8;

interface Position {
  top: number;
  left: number;
  /** Whether the tooltip sits above the trigger — decides the Y transform. */
  above: boolean;
}

export function Tooltip({ content, children, side = "top", delay = 400 }: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<Position | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const show = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    /*
     * Decide the side from the room left at the viewport edges, then derive the
     * Y transform from the side that actually won.
     *
     * The previous version derived the transform from the numeric position
     * (`top < 100`), which conflated "there is no room above" with "shift up by
     * my own height": a side="bottom" tooltip whose anchor sat below y=100 was
     * translated by -100% and rendered on top of its own trigger.
     */
    const fitsAbove = box.top >= FLIP_ROOM;
    const fitsBelow = window.innerHeight - box.bottom >= FLIP_ROOM;
    const above = side === "top" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
    setPosition({
      top: above ? box.top - GAP : box.bottom + GAP,
      left: box.left + box.width / 2,
      above
    });
  }, [side]);

  const hide = useCallback(() => { clearTimer(); setPosition(null); }, [clearTimer]);

  /*
   * translate(-50%) centres the tooltip on the trigger, which pushes it past a
   * viewport edge for an anchor near one. The tooltip's own width is only known
   * once it is in the DOM, so re-clamp it in a layout effect — that runs before
   * the browser paints, so the correction is never visible as a jump.
   */
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip || !position) return;
    const half = tooltip.offsetWidth / 2;
    const min = EDGE_MARGIN + half;
    const max = window.innerWidth - EDGE_MARGIN - half;
    // Wider than the viewport: there is no valid clamp, so centre it.
    const left = min > max ? window.innerWidth / 2 : Math.min(Math.max(position.left, min), max);
    if (left !== position.left) setPosition({ top: position.top, left, above: position.above });
  }, [position]);

  const onEnter = () => { clearTimer(); timer.current = setTimeout(show, delay); };
  // Focus shows immediately: keyboard users should not wait.
  const onFocus = () => { clearTimer(); show(); };

  const child = cloneElement(children, {
    "aria-describedby": position ? id : children.props["aria-describedby"],
    ref: (node: HTMLElement | null) => { anchorRef.current = node; },
    onMouseEnter: onEnter,
    onMouseLeave: hide,
    onFocus,
    onBlur: hide,
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Escape") hide(); }
  } as never);

  return (
    <>
      {child}
      {position ? (
        <div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className={styles.tooltip}
          style={{ top: position.top, left: position.left, transform: `translate(-50%, ${position.above ? "-100%" : "0"})` }}
        >
          {content}
        </div>
      ) : null}
    </>
  );
}
