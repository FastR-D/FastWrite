import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import styles from "./Table.module.css";

export interface TableProps {
  /** Column headers, rendered as a <thead> row. */
  columns: ReactNode[];
  children: ReactNode;
  /** Zebra-stripe the body rows. */
  stripped?: boolean;
  /** Accessible name. Required — a table with no caption is hard to navigate. */
  label: string;
  className?: string;
}

export function Table({ columns, children, stripped = false, label, className = "" }: TableProps) {
  return (
    <div className={`${styles.wrapper} ${className}`.trim()}>
      <table className={`${styles.table} ${stripped ? styles.stripped : ""}`.trim()} aria-label={label}>
        <thead>
          <tr>{columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export interface TableRowProps {
  children: ReactNode;
  className?: string;
}

export function TableRow({ children, className = "" }: TableRowProps) {
  return <tr className={className}>{children}</tr>;
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children: ReactNode;
  /** Render as a row header instead of a data cell. */
  header?: boolean;
}

export function TableCell({ children, header = false, ...rest }: TableCellProps) {
  return header
    ? <th scope="row" {...(rest as ThHTMLAttributes<HTMLTableCellElement>)}>{children}</th>
    : <td {...rest}>{children}</td>;
}
