import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./QuickPick.module.css";

export interface QuickPickItem {
  id: string;
  /** Shown in the row and used as its accessible name. */
  label: string;
  /** Dimmed secondary text under the label. */
  detail?: ReactNode;
}

export interface QuickPickProps {
  items: QuickPickItem[];
  /** Case-insensitive substring filter. Omit to render every item. */
  filter?: boolean;
  /** Accessible name for the listbox. */
  label: string;
  /**
   * Accessible name for the filter input, when naming it after the list would
   * read wrong — "Matching files" names a list, not the field you type in.
   * Defaults to `label`.
   */
  filterLabel?: string;
  onSelect: (id: string) => void;
  /**
   * Text for the empty list. Pass "" to render nothing, for a caller that is
   * showing its own loading or error line in the same place.
   */
  emptyMessage?: string;
}

const MAX_VISIBLE = 100;

/**
 * A filterable listbox with keyboard selection.
 *
 * Arrow keys move the highlight, Enter picks, and the list is capped so a
 * project with thousands of files does not render thousands of rows. Focus
 * stays in the filter input and aria-activedescendant points at the highlighted
 * row, which is the combobox pattern — moving DOM focus into the list would
 * break typing.
 */
export function QuickPick({ items, filter = true, label, filterLabel = label, onSelect, emptyMessage = "No matches" }: QuickPickProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const listboxId = useRef(`quickpick-${Math.random().toString(36).slice(2, 9)}`).current;
  const optionId = (position: number) => `${listboxId}-option-${position}`;

  const needle = query.trim().toLowerCase();
  const visible = (filter && needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items).slice(0, MAX_VISIBLE);

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const active = visible[index];

  return (
    <div className={styles.wrapper}>
      {filter ? (
        <input
          className={styles.filter}
          autoFocus
          aria-label={filterLabel}
          aria-controls={listboxId}
          aria-activedescendant={active ? optionId(index) : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(current + 1, visible.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(current - 1, 0)); }
            else if (event.key === "Home") { event.preventDefault(); setIndex(0); }
            else if (event.key === "End") { event.preventDefault(); setIndex(visible.length - 1); }
            else if (event.key === "Enter") { event.preventDefault(); if (active) onSelect(active.id); }
          }}
        />
      ) : null}
      <div className={styles.list} id={listboxId} role="listbox" aria-label={label} ref={list}>
        {visible.map((item, position) => (
          <button
            type="button"
            key={item.id}
            id={optionId(position)}
            role="option"
            aria-selected={position === index}
            className={`${styles.row} ${position === index ? styles.active : ""}`.trim()}
            onMouseEnter={() => setIndex(position)}
            onClick={() => onSelect(item.id)}
          >
            <span className={styles.label}>{item.label}</span>
            {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
          </button>
        ))}
        {/*
          * An empty message is optional: a caller that shows its own "loading"
          * line in this spot passes "" and gets no second, contradicting
          * sentence underneath it.
          */}
        {!visible.length && emptyMessage ? <p className={styles.empty}>{emptyMessage}</p> : null}
      </div>
    </div>
  );
}
