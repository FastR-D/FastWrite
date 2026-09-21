import { useEffect, useRef, type ReactNode } from "react";
import styles from "./TabBar.module.css";

export interface TabItem {
  /** Stable identity for the tab. */
  id: string;
  label: ReactNode;
  /** Tooltip; defaults to nothing. */
  title?: string;
  /** The id of the panel this tab controls, wired to aria-controls. */
  controls?: string;
  /** Rendered before the label, typically an icon. */
  icon?: ReactNode;
  /** Show the unsaved marker. */
  dirty?: boolean;
  /** Italic, for an unpinned preview tab. */
  preview?: boolean;
}

export interface TabBarProps {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Accessible name. Required. */
  label: string;
  /** Omit for a simple row; supply both to get per-tab close buttons. */
  onClose?: (id: string) => void;
  /** Called on double-click — the pin gesture. */
  onActivate?: (id: string) => void;
  /** Accessible label for a tab's close button. */
  closeLabel?: (tab: TabItem) => string;
  /** Scroll the active tab into view when it changes. */
  scrollActiveIntoView?: boolean;
  className?: string;
}

/**
 * A tab strip.
 *
 * Roving tabindex, per the ARIA tabs pattern: exactly one tab is focusable, and
 * the arrow keys move between them, so Tab leaves the strip rather than walking
 * every tab. Home/End jump to the ends.
 *
 * `aria-selected` is the state of record — the stylesheet keys off it too, so a
 * caller cannot leave the visual and the accessible state disagreeing.
 */
export function TabBar({ tabs, activeId, onSelect, label, onClose, onActivate, closeLabel, scrollActiveIntoView = false, className = "" }: TabBarProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollActiveIntoView) return;
    host.current?.querySelector('[aria-selected="true"]')?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, scrollActiveIntoView]);

  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  const focusAt = (index: number) => {
    onSelect(tabs[index]!.id);
    (host.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index])?.focus();
  };

  return (
    <div
      ref={host}
      className={`${styles.bar} ${onClose ? "" : styles.simple} ${className}`.trim()}
      role="tablist"
      aria-label={label}
      onWheel={(event) => {
        // A vertical wheel over a horizontal strip scrolls the strip.
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={styles.item}
            onAuxClick={(event) => {
              if (event.button === 1 && onClose) { event.preventDefault(); onClose(tab.id); }
            }}
          >
            <button
              type="button"
              role="tab"
              className={`${styles.tab} ${selected ? styles.active : ""} ${tab.preview ? styles.preview : ""}`.trim()}
              aria-controls={tab.controls}
              aria-selected={selected}
              tabIndex={selected || (activeIndex < 0 && index === 0) ? 0 : -1}
              title={tab.title}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={onActivate ? () => onActivate(tab.id) : undefined}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                const next =
                  event.key === "ArrowRight" ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home" ? 0
                  : event.key === "End" ? tabs.length - 1
                  : -1;
                if (next >= 0) { event.preventDefault(); focusAt(next); }
              }}
            >
              {tab.icon}
              <span className={styles.label}>{tab.label}</span>
              {tab.dirty ? <span className={styles.dirty} aria-label="Unsaved changes">●</span> : null}
            </button>
            {onClose ? (
              <button
                type="button"
                className={styles.close}
                aria-label={closeLabel ? closeLabel(tab) : `Close ${tab.id}`}
                title={closeLabel ? closeLabel(tab) : `Close ${tab.id}`}
                onClick={() => onClose(tab.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
