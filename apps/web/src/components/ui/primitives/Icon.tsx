import { Icon as VscruiIcon } from "vscrui";
import { type IconName } from "../icons";
import styles from "./Icon.module.css";

export interface IconProps {
  name: IconName;
  /** Rendered size in pixels. Defaults to the workbench text size. */
  size?: number;
  /** Rotate continuously — for in-progress states. */
  spin?: boolean;
  className?: string;
  /**
   * Hide from assistive technology. Defaults to true because icons here are
   * decorative: the accessible name comes from the surrounding control. It is
   * NOT applied when `aria-label` is set — a hidden element's label is
   * ignored, so the two would cancel out.
   */
  "aria-hidden"?: boolean;
  /**
   * Accessible name, when the icon carries meaning on its own. Applied to the
   * wrapper span, which is the element `aria-hidden` also governs, so the two
   * cannot disagree.
   *
   * This exists because lucide icons accepted `aria-label` directly, and the
   * sweep would otherwise have had to downgrade those to `title` — a weaker
   * mechanism, since a title only supplies an accessible name as a last resort
   * after `aria-labelledby` and `aria-label`.
   */
  "aria-label"?: string;
  title?: string;
}

export function Icon({ name, size = 16, spin = false, className = "", "aria-hidden": ariaHidden, "aria-label": ariaLabel, ...rest }: IconProps) {
  const classes = [styles.icon, spin ? styles.spin : "", className].filter(Boolean).join(" ");
  /*
   * Decorative by default, but a labelled icon must stay visible to assistive
   * technology or its label is dead weight. An explicit `aria-hidden` always
   * wins over both defaults.
   */
  const hidden = ariaHidden ?? ariaLabel === undefined;
  return (
    <span
      className={classes}
      style={{ width: size, height: size }}
      {...(hidden ? { "aria-hidden": true } : {})}
      {...(ariaLabel !== undefined ? { role: "img", "aria-label": ariaLabel } : {})}
      {...rest}
    >
      <VscruiIcon name={name} spin={false} size={size} />
    </span>
  );
}
