import { Fragment } from "react";
import { FieldContext } from "./Field";
import { Select, type SelectProps } from "./Select";
import { Icon } from "../primitives/Icon";
import { icons } from "../icons";
import styles from "./BreadcrumbSelect.module.css";

export interface BreadcrumbSelectStep extends Pick<SelectProps, "value" | "onChange" | "options" | "placeholder" | "disabled" | "searchable"> {
  id: string;
  label: string;
}

export interface BreadcrumbSelectProps {
  label: string;
  steps: BreadcrumbSelectStep[];
  disabled?: boolean;
}

/** Editable path: each segment selects one level; callers own dependent values. */
export function BreadcrumbSelect({ label, steps, disabled = false }: BreadcrumbSelectProps) {
  return <FieldContext.Provider value={null}>
    <div className={styles.path} role="group" aria-label={label}>
      {steps.map(({ id, label: stepLabel, ...step }, index) => <Fragment key={id}>
        {index ? <span className={styles.separator} aria-hidden="true"><Icon name={icons.chevronRight} size={12} /></span> : null}
        <div className={styles.step}><Select {...step} aria-label={stepLabel} disabled={disabled || step.disabled === true} appearance="breadcrumb" portal /></div>
      </Fragment>)}
    </div>
  </FieldContext.Provider>;
}
