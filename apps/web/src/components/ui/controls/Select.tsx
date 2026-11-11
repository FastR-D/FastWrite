import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { icons } from "../icons";
import { Icon } from "../primitives/Icon";
import { useFieldWiring } from "./Field";
import styles from "./Select.module.css";

export interface SelectOption {
  value: string;
  label: string;
  /** Compact text in the trigger; the menu retains the full label. */
  shortLabel?: string;
  disabled?: boolean;
  icon?: ReactNode;
  description?: string;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export type SelectEntry = SelectOption | SelectOptionGroup;

export interface SelectProps {
  /**
   * Options, or groups of them. A flat array renders as a plain list, an array
   * of groups renders as labelled sections (replacing <optgroup>), and a MIXED
   * array renders both — which is what a `<select>` with an `<optgroup>` and a
   * leading "none" entry actually is. Requiring all-or-nothing forced such a
   * call site to drop either the groups or the ability to clear the value.
   */
  options: SelectEntry[];
  value?: string | undefined;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Enable filtering. Defaults to on when there are more than 10 options. */
  searchable?: boolean;
  /** Render the list above the trigger instead of below. */
  position?: "above" | "below";
  appearance?: "field" | "toolbar" | "breadcrumb";
  /** Float within the nearest dialog (or viewport), outside scrolling form content. */
  portal?: boolean;
  id?: string;
  name?: string;
  invalid?: boolean;
  "aria-describedby"?: string | undefined;
  "aria-label"?: string;
  className?: string;
}

/** A group is the only entry kind that carries nested options. */
function isGroup(entry: SelectEntry): entry is SelectOptionGroup {
  return "options" in entry;
}

function flatten(options: SelectEntry[]): SelectOption[] {
  return options.flatMap((entry) => (isGroup(entry) ? entry.options : [entry]));
}

export function Select({
  options,
  value,
  onChange,
  placeholder = "请选择…",
  disabled = false,
  searchable,
  position = "below",
  appearance = "field",
  portal = false,
  id,
  invalid,
  "aria-describedby": describedBy,
  className = "",
  ...rest
}: SelectProps) {
  const generatedId = useId();
  const wiring = useFieldWiring();
  const selectId = id ?? wiring?.id ?? generatedId;
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;
  const listboxId = `${selectId}-listbox`;
  const optionId = (index: number) => `${selectId}-option-${index}`;

  const allOptions = useMemo(() => flatten(options), [options]);
  const canSearch = searchable ?? allOptions.length > 10;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState<{ container: HTMLElement; style: CSSProperties } | null>(null);

  useLayoutEffect(() => {
    if (!open || !portal) { setFloating(null); return; }
    const anchor = wrapperRef.current;
    if (!anchor) return;
    const dialog = anchor.closest<HTMLElement>('[role="dialog"]');
    const container = dialog ?? document.body;
    const update = () => {
      const trigger = anchor.getBoundingClientRect();
      const boundary = dialog?.getBoundingClientRect();
      const leftEdge = boundary?.left ?? 0;
      const rightEdge = boundary?.right ?? window.innerWidth;
      const footer = dialog?.querySelector<HTMLElement>(".dialog__footer")?.getBoundingClientRect();
      const bottom = footer?.top ?? boundary?.bottom ?? window.innerHeight;
      const width = Math.min(Math.max(trigger.width, 280), 360, rightEdge - leftEdge - 24);
      const left = Math.max(leftEdge + 12, Math.min(trigger.left, rightEdge - width - 12));
      const top = trigger.bottom + 4;
      const upperEdge = dialog?.querySelector<HTMLElement>(".dialog__header")?.getBoundingClientRect().bottom ?? boundary?.top ?? 0;
      setFloating({ container, style: {
        position: dialog ? "absolute" : "fixed",
        left: left - (boundary?.left ?? 0) - (dialog?.clientLeft ?? 0),
        top: position === "above" ? "auto" : top - (boundary?.top ?? 0) - (dialog?.clientTop ?? 0),
        right: "auto",
        bottom: position === "above" ? (boundary?.bottom ?? window.innerHeight) - trigger.top + 4 - (dialog?.clientTop ?? 0) : "auto",
        width,
        maxHeight: Math.max(0, Math.min(320, position === "above" ? trigger.top - upperEdge - 12 : bottom - top - 8)),
      } });
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popoverRef.current?.contains(event.target)) update(); };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", scroll, true);
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    if (dialog) observer.observe(dialog);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", scroll, true); };
  }, [open, portal, position]);

  /*
   * Filtering maps over entries, not over a flat list: a mixed array must keep
   * its flat entries and its groups in order, and a group whose options all
   * filtered out disappears rather than rendering an empty heading.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    const keep = (option: SelectOption) => option.label.toLowerCase().includes(needle);
    return options
      .map((entry) => (isGroup(entry) ? { ...entry, options: entry.options.filter(keep) } : entry))
      .filter((entry) => (isGroup(entry) ? entry.options.length > 0 : keep(entry)));
  }, [options, query]);

  const visibleFlat = useMemo(() => flatten(visible), [visible]);

  const selected = useMemo(() => allOptions.find((option) => option.value === value), [allOptions, value]);

  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);

  // Close on outside pointer down.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node) && !popoverRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  /*
   * Position the highlight on the selected option when the list opens.
   *
   * The ref gate is load-bearing: the effect below also depends on
   * `visibleFlat`, whose identity changes on every parent render at the call
   * sites that build `options` inline with `.map()`. Without it, a parent
   * re-render while the list is open would yank the highlight back to the
   * selected option mid-navigation — the exact defect that ruled out vscrui's
   * Dropdown. So the reset happens once per open, never per render.
   */
  const positioned = useRef(false);
  useEffect(() => {
    if (!open) {
      positioned.current = false;
      return;
    }
    if (positioned.current) return;
    positioned.current = true;
    const index = visibleFlat.findIndex((option) => option.value === value);
    setActiveIndex(index >= 0 ? index : 0);
  }, [open, value, visibleFlat]);

  /*
   * Keep the highlight inside the list when filtering shrinks it, without
   * touching it while the list is merely re-created.
   */
  useEffect(() => {
    setActiveIndex((current) => (current < visibleFlat.length ? current : 0));
  }, [visibleFlat.length]);

  /*
   * With a filter field rendered, the input is the combobox (see the markup
   * comment below), so it is the element that holds focus. Committing closes
   * the list, which unmounts that input; React does not move focus off a removed
   * element, so it would fall to <body> and the keyboard user would be stranded.
   * Hand it back to the trigger, exactly as Escape already does.
   */
  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    onChange?.(option.value);
    if (canSearch) triggerRef.current?.focus();
    close();
  };

  const move = (delta: number) => {
    if (!visibleFlat.length) return;
    let next = activeIndex;
    for (let step = 0; step < visibleFlat.length; step++) {
      next = (next + delta + visibleFlat.length) % visibleFlat.length;
      if (!visibleFlat[next]!.disabled) break;
    }
    setActiveIndex(next);
  };

  const jump = (to: "first" | "last") => {
    if (!visibleFlat.length) return;
    if (to === "first") { setActiveIndex(0); return; }
    setActiveIndex(visibleFlat.length - 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;

    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case "Escape": {
        event.preventDefault();
        event.stopPropagation();
        close();
        // Escape returns focus to the trigger. When the filter field is open,
        // the focused element is about to unmount, so focus it first while the
        // DOM (and the input) is still mounted.
        triggerRef.current?.focus();
        return;
      }
      case "Tab": close(); return;
      case "Enter": {
        event.preventDefault();
        const option = visibleFlat[activeIndex];
        if (option) commit(option);
        return;
      }
      case "ArrowDown": event.preventDefault(); move(1); return;
      case "ArrowUp": event.preventDefault(); move(-1); return;
      case "Home":
      case "End": {
        /*
         * Deliberate split. With a filter field the input is the combobox and a
         * real caret exists, so Home/End belong to it — the APG editable-combobox
         * pattern keeps caret movement in the textbox and leaves list navigation
         * to the arrow keys. Without a filter field focus is on the trigger,
         * which has no caret, so Home/End are free to jump the highlight.
         */
        if (canSearch) return;
        event.preventDefault();
        jump(event.key === "Home" ? "first" : "last");
        return;
      }
      default: break;
    }

    /*
     * Typeahead on the trigger ("press g to jump to Gamma"). Skipped when the
     * filter field is present: there the printable key is already going into the
     * input, which narrows the list itself, and hijacking it would fight the
     * filter and move the highlight to an option the user did not type.
     */
    if (canSearch) return;
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const needle = event.key.toLowerCase();
      const start = activeIndex;
      for (let step = 1; step <= visibleFlat.length; step++) {
        const index = (start + step) % visibleFlat.length;
        const option = visibleFlat[index]!;
        if (!option.disabled && option.label.toLowerCase().startsWith(needle)) {
          setActiveIndex(index);
          return;
        }
      }
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const list = popoverRef.current?.querySelector<HTMLElement>('[role="listbox"]');
    const option = document.getElementById(optionId(activeIndex));
    if (!list || !option || !list.contains(option)) return;
    const viewport = list.getBoundingClientRect();
    const item = option.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop -= viewport.top - item.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  }, [open, activeIndex, floating?.container]);

  const activeOption = visibleFlat[activeIndex];
  /*
   * The element that carries the combobox role is the element that holds focus,
   * because that is the element an assistive technology reads aria-expanded and
   * aria-activedescendant off. Closed, that is the trigger button. Open with a
   * filter field, the input takes focus (autoFocus), so the role moves to it and
   * the trigger falls back to a plain button that re-opens the list.
   *
   * Do NOT "simplify" this back to a single role="combobox" on the trigger: the
   * focused element would then be the filter textbox with no role, no
   * aria-controls and no aria-activedescendant, so every arrow-key movement
   * would update a highlight that is never announced. That is the APG editable
   * combobox failing on its primary path.
   */
  const comboboxOnInput = canSearch && open;
  let runningIndex = -1;

  const renderPopover = () => (
    <div ref={popoverRef} className={`${styles.popover} ${portal ? styles.portalPopover : ""}`} style={portal ? floating?.style : undefined}>
      {canSearch ? (
        <div className={styles.search}>
          {/*
           * A raw <input>, not the TextField primitive: this element is the
           * combobox, and TextField's contract deliberately has no role or
           * aria-activedescendant pass-through. Its look mirrors
           * TextField.input in the stylesheet.
           */}
          <input
            type="text"
            className={styles.filter}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选…"
            role="combobox"
            aria-expanded
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
            aria-label={rest["aria-label"] ?? "筛选选项"}
            aria-invalid={resolvedInvalid || undefined}
            aria-describedby={resolvedDescribedBy}
            autoFocus
          />
        </div>
      ) : null}

      <div className={styles.listbox} id={listboxId} role="listbox" aria-label={rest["aria-label"]}>
        {visible.map((entry) =>
          isGroup(entry) ? (
            <div className={styles.group} role="group" aria-label={entry.label} key={entry.label}>
              <div className={styles.groupLabel}>{entry.label}</div>
              {entry.options.map((option) => {
                runningIndex += 1;
                return renderOption(option, runningIndex);
              })}
            </div>
          ) : (
            (() => {
              runningIndex += 1;
              return renderOption(entry, runningIndex);
            })()
          )
        )}

        {!visibleFlat.length ? <div className={styles.empty}>没有匹配项</div> : null}
      </div>
    </div>
  );

  return (
    <div
      ref={wrapperRef}
      className={`${styles.wrapper} ${position === "above" ? styles.above : ""} ${appearance === "toolbar" ? styles.toolbar : appearance === "breadcrumb" ? styles.breadcrumb : ""} ${className}`.trim()}
      onKeyDown={onKeyDown}
    >
      <button
        {...rest}
        ref={triggerRef}
        type="button"
        title={selected?.shortLabel ? selected.label : undefined}
        id={selectId}
        className={`${styles.trigger} ${resolvedInvalid ? styles.invalid : ""}`.trim()}
        role={comboboxOnInput ? undefined : "combobox"}
        aria-expanded={comboboxOnInput ? undefined : open}
        aria-haspopup={comboboxOnInput ? undefined : "listbox"}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={!comboboxOnInput && open && activeOption ? optionId(activeIndex) : undefined}
        aria-describedby={resolvedDescribedBy}
        aria-invalid={resolvedInvalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={`${styles.value} ${selected ? "" : styles.placeholder}`.trim()}>
          {selected?.icon ? <span className={styles.optionIcon} aria-hidden="true">{selected.icon}</span> : null}
          <span className={styles.valueText}>{selected ? selected.shortLabel ?? selected.label : placeholder}</span>
        </span>
        <span className={styles.chevron} aria-hidden="true"><Icon name={icons.chevronDown} size={14} /></span>
      </button>

      {open ? portal ? floating ? createPortal(renderPopover(), floating.container) : null : renderPopover() : null}
    </div>
  );

  function renderOption(option: SelectOption, index: number) {
    return (
      <div
        key={option.value}
        id={optionId(index)}
        className={`${styles.option} ${index === activeIndex ? styles.active : ""}`.trim()}
        role="option"
        aria-selected={option.value === value}
        aria-label={option.description ? option.label : undefined}
        aria-describedby={option.description ? `${optionId(index)}-description` : undefined}
        aria-disabled={option.disabled || undefined}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => commit(option)}
      >
        <span className={styles.optionContent}>
          {option.icon ? <span className={styles.optionIcon} aria-hidden="true">{option.icon}</span> : null}
          <span className={styles.optionText}>
            <span className={styles.optionLabel}>{option.label}</span>
            {option.description ? <span className={styles.description} id={`${optionId(index)}-description`}>{option.description}</span> : null}
          </span>
        </span>
        {option.value === value ? <Icon name={icons.check} size={14} /> : null}
      </div>
    );
  }
}
