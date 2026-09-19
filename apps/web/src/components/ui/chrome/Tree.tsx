import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import styles from "./Tree.module.css";

/*
 * What this component owns, and what it deliberately does not.
 *
 * FileTree does three separable things: it derives the visible rows from a tree
 * plus an expanded set, it virtualises them, and it renders each row. Only the
 * last two are generic. Expansion and lazy loading stay in the caller — that
 * state is domain-specific, because a directory is loaded over the API.
 *
 * Rows therefore arrive as a render prop rather than as data: `Tree` owns
 * `role="treeitem"`, `aria-selected`, the absolute `top` that virtualisation
 * computes and the left padding that depth implies, while the label markup —
 * including the `<span title={path}>` that sixteen Playwright selectors look
 * for — is written by the caller and survives untouched. That is the whole
 * point of the boundary: flattening it would either drag the file-kind
 * vocabulary into a generic component or break those selectors.
 */

const OVERSCAN = 8;
/** Breathing room above the first row and below the last, in px. */
const EDGE_PADDING = 4;
/** Used until the ResizeObserver reports the real height. */
const DEFAULT_VIEWPORT_HEIGHT = 500;

export interface TreeProps<T> {
  rows: T[];
  /** Stable key per row; also used to find the selected row for scroll-into-view. */
  rowKey: (row: T, index: number) => string;
  /** Fixed row height, required for virtualisation. */
  rowHeight: number;
  /** Accessible name for the tree. Required. */
  label: string;
  selectedKey?: string | null;
  /** Left padding for a row, in px — the caller's depth. Defaults to 0. */
  rowIndent?: (row: T, index: number) => number;
  /**
   * Attributes for a row's treeitem element — `aria-expanded`, `aria-busy`, the
   * click handlers. They are the caller's state, so the caller supplies them;
   * `Tree` still wins on the attributes it owns (role, selection, position).
   */
  rowProps?: (row: T, index: number) => HTMLAttributes<HTMLButtonElement>;
  /** Render one row's contents. The wrapper supplies role, position and size. */
  renderRow: (row: T, index: number) => ReactNode;
  className?: string;
}

export function Tree<T>({ rows, rowKey, rowHeight, label, selectedKey = null, rowIndent, rowProps, renderRow, className = "" }: TreeProps<T>) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry?.contentRect.height ?? DEFAULT_VIEWPORT_HEIGHT));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep the selected row in view when the selection changes from elsewhere —
  // opening a file from the quick picker, say.
  useEffect(() => {
    const element = viewport.current;
    if (!element || !selectedKey) return;
    const index = rows.findIndex((row, offset) => rowKey(row, offset) === selectedKey);
    if (index < 0) return;
    const rowTop = index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewBottom = element.scrollTop + viewportHeight;
    if (rowTop < element.scrollTop) element.scrollTop = rowTop;
    else if (rowBottom > viewBottom) element.scrollTop = Math.max(0, rowBottom - viewportHeight);
  }, [rows, rowKey, rowHeight, selectedKey, viewportHeight]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN);

  return (
    <div
      ref={viewport}
      className={`${styles.viewport} ${className}`.trim()}
      role="tree"
      aria-label={label}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {/* The canvas is full height so the scrollbar reflects every row, not
          just the rendered ones. */}
      <div className={styles.canvas} style={{ height: rows.length * rowHeight + EDGE_PADDING * 2 }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          const key = rowKey(row, index);
          const selected = key === selectedKey;
          return (
            <button
              key={key}
              type="button"
              {...rowProps?.(row, index)}
              className={styles.row}
              style={{ top: EDGE_PADDING + index * rowHeight, height: rowHeight, paddingLeft: rowIndent?.(row, index) ?? 0 }}
              role="treeitem"
              aria-selected={selected}
            >
              {renderRow(row, index)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Class names for the markup a caller puts inside `renderRow` — the label and
 * the file-kind glyphs. They live here because they are the row's presentation,
 * and the render prop is what keeps that markup in the caller.
 */
/*
 * The `?? ""` is not decoration: `noUncheckedIndexedAccess` makes every CSS
 * module lookup `string | undefined`, and `Icon`'s `className` prop does not
 * accept undefined under `exactOptionalPropertyTypes`.
 */
export const treeRowClasses = {
  label: styles.label ?? "",
  folder: styles.folder ?? "",
  tex: styles.tex ?? "",
  image: styles.image ?? "",
  text: styles.text ?? "",
  main: styles.main ?? ""
};
