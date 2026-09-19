/*
 * Single entry point for the UI layer. Business code imports from here:
 *
 *   import { Button, Field, TextField } from "../ui";
 *
 * Nothing outside this directory may render a raw control element; see
 * no-raw-controls.test.ts.
 */

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./primitives/Button";
export { IconButton, type IconButtonProps } from "./primitives/IconButton";
export { TextField, type TextFieldProps } from "./primitives/TextField";
export { TextArea, type TextAreaProps } from "./primitives/TextArea";
export { Checkbox, type CheckboxProps } from "./primitives/Checkbox";
export { Icon, type IconProps } from "./primitives/Icon";
export { Tag, type TagProps } from "./primitives/Tag";
export { Badge, type BadgeProps } from "./primitives/Badge";
export { Divider, type DividerProps } from "./primitives/Divider";
export { Loader, type LoaderProps } from "./primitives/Loader";
export { Label, type LabelProps } from "./primitives/Label";
export { View, type ViewProps } from "./primitives/View";
export { Table, TableRow, TableCell, type TableProps, type TableRowProps, type TableCellProps } from "./primitives/Table";

export { Field, type FieldProps, type FieldRenderProps } from "./controls/Field";
export { Select, type SelectProps, type SelectOption, type SelectOptionGroup } from "./controls/Select";
export { MultiSelect, type MultiSelectProps, type MultiSelectOption } from "./controls/MultiSelect";
export { NumberField, type NumberFieldProps } from "./controls/NumberField";
export { FileField, type FileFieldProps } from "./controls/FileField";

export { Alert, type AlertProps, type AlertTone } from "./feedback/Alert";
export { Spinner, type SpinnerProps } from "./feedback/Spinner";
export { ProgressBar, type ProgressBarProps } from "./feedback/ProgressBar";
export { EmptyState, type EmptyStateProps } from "./feedback/EmptyState";
export { Tooltip, type TooltipProps } from "./feedback/Tooltip";

export { Dialog, type DialogProps } from "./chrome/Dialog";
export { ThemeToggle } from "./chrome/ThemeToggle";
export { Link, linkTarget, type LinkProps } from "./chrome/Link";
export { List, ListRow, ListRowText, ListEmpty, type ListProps, type ListRowProps } from "./chrome/ListRow";
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from "./chrome/SegmentedControl";
export { Disclosure, type DisclosureProps } from "./chrome/Disclosure";
export { StatusBar, StatusItem, type StatusBarProps, type StatusItemProps } from "./chrome/StatusBar";
export { TabBar, type TabBarProps, type TabItem } from "./chrome/TabBar";
export { SplitHandle, type SplitHandleProps } from "./chrome/SplitHandle";
export { QuickPick, type QuickPickProps, type QuickPickItem } from "./chrome/QuickPick";
export { Tree, treeRowClasses, type TreeProps } from "./chrome/Tree";
export { Stepper, type StepperProps, type Step, type StepStatus } from "./chrome/Stepper";

export { icons, type IconName } from "./icons";
