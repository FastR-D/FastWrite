/**
 * codicon names used by the application.
 *
 * This module is the app's icon vocabulary: every icon the application
 * references is named here, so the vocabulary lives in one place and gets
 * type-checked against vscrui's `Icon` component, whose `name` prop is
 * `keyof typeof Icons`.
 *
 * The codicon set is the sole source of glyphs; the app has no other icon
 * library.
 */
export const icons = {
  /* Files and folders */
  file: "file",
  fileCode: "file-code",
  fileMedia: "file-media",
  fileZip: "file-zip",
  folder: "folder",
  folderOpened: "folder-opened",
  listTree: "list-tree",
  fileText: "file-text",
  filePdf: "file-pdf",
  newFile: "new-file",

  /* Navigation and layout */
  chevronDown: "chevron-down",
  chevronLeft: "chevron-left",
  chevronRight: "chevron-right",
  chevronUp: "chevron-up",
  arrowLeft: "arrow-left",
  arrowRight: "arrow-right",
  screenFull: "screen-full",
  /* A window-shaped maximize, to tell "fullscreen" apart from "wide".
     screen-full and screen-normal are the only expand/contract pair codicon
     has, so a third size button would otherwise repeat a glyph. */
  windowMaximize: "chrome-maximize",
  screenNormal: "screen-normal",
  close: "close",
  ellipsis: "ellipsis",

  /* Actions */
  add: "add",
  check: "check",
  edit: "edit",
  refresh: "refresh",
  save: "save",
  search: "search",
  trash: "trash",
  copy: "copy",
  discard: "discard",
  send: "send",
  share: "share",
  tools: "tools",
  signOut: "sign-out",
  zoomIn: "zoom-in",
  zoomOut: "zoom-out",
  gripper: "gripper",
  searchFuzzy: "search-fuzzy",
  arrowBoth: "arrow-both",
  layoutPanelRight: "layout-panel-right",

  /*
   * Two lucide icons have no codicon equivalent and are approximated:
   *   - `Undo2` / `RotateCcw` → `discard`. The codicon set has no undo or redo
   *     affordance at all (verified against all 542 names).
   *   - `CloudOff` → `circleFilled`. There is no `cloud-off`; this icon marks
   *     unsaved editor state, and a filled circle is VSCode's own dirty
   *     indicator, so the approximation is arguably the better glyph.
   */
  /* Status and feedback */
  error: "error",
  info: "info",
  warning: "warning",
  checkAll: "check-all",
  loading: "loading",
  sync: "sync",
  pulse: "pulse",
  circleSlash: "circle-slash",
  shield: "shield",
  verified: "verified",
  sparkle: "sparkle",
  passFilled: "pass-filled",
  circleFilled: "circle-filled",

  /* Domain: git and history */
  gitCompare: "git-compare",
  gitMerge: "git-merge",
  gitCommit: "git-commit",
  sourceControl: "source-control",
  history: "history",
  clockface: "clockface",
  repo: "repo",
  github: "github",

  /* Domain: workspace */
  files: "files",
  book: "book",
  bookmark: "bookmark",
  checklist: "checklist",
  database: "database",
  settingsGear: "settings-gear",
  account: "account",
  personAdd: "person-add",
  key: "key",
  bell: "bell",
  comment: "comment",
  colorMode: "color-mode",
  link: "link",
  linkExternal: "link-external",
  cloudDownload: "cloud-download",
  cloudUpload: "cloud-upload",
  symbolOperator: "symbol-operator",
  typeHierarchy: "type-hierarchy",
  target: "target",
  pin: "pin",
  type: "symbol-method",
  organization: "organization",
  symbolNumeric: "symbol-numeric",
  robot: "robot"
} as const;

export type IconName = (typeof icons)[keyof typeof icons];
