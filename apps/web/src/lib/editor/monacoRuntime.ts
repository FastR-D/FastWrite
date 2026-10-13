// Load the bundled Simplified Chinese labels before Monaco creates its actions.
// The application has one fixed UI language; there is no runtime locale switch.
import "monaco-editor/nls/lang/zh-cn.js";
export * from "monaco-editor";
