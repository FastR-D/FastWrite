import * as monaco from "monaco-editor";
import EditorWorker from "./monacoWorker?worker";
declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (_moduleId: string, _label: string) => Worker };
  }
}

let monacoConfigured = false;

export function configureMonaco() {
  if (monacoConfigured) return;
  monacoConfigured = true;
  window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  if (!monaco.languages.getLanguages().some((language) => language.id === "latex")) {
    monaco.languages.register({ id: "latex", extensions: [".tex", ".sty", ".cls", ".bib"] });
    monaco.languages.setMonarchTokensProvider("latex", {
      tokenizer: {
        root: [
          [/%.*$/, "comment"],
          [/\\(?:begin|end)(?=\{)/, "keyword.control"],
          [/\\[a-zA-Z@]+\*?/, "keyword"],
          [/\\./, "string.escape"],
          [/\$\$?/, { token: "string", next: "@math" }],
          [/[{}[\]()]/, "delimiter.bracket"],
          [/[&_^]/, "operator"]
        ],
        math: [
          [/\\[a-zA-Z@]+\*?/, "type"],
          [/\$\$?/, { token: "string", next: "@pop" }],
          [/[{}[\]()]/, "delimiter.bracket"],
          [/./, "string"]
        ]
      }
    });
    monaco.languages.setLanguageConfiguration("latex", {
      comments: { lineComment: "%" },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: "$", close: "$" }],
      surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: "$", close: "$" }]
    });
  }
  monaco.editor.defineTheme("fastwrite-github", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6E7781" },
      { token: "keyword", foreground: "CF222E" },
      { token: "keyword.control", foreground: "8250DF", fontStyle: "bold" },
      { token: "type", foreground: "0550AE" },
      { token: "string", foreground: "0A3069" },
      { token: "string.escape", foreground: "116329" },
      { token: "operator", foreground: "8250DF" }
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#24292F",
      "editorGutter.background": "#F6F8FA",
      "editorLineNumber.foreground": "#8C959F",
      "editorLineNumber.activeForeground": "#24292F",
      "editor.lineHighlightBackground": "#F6F8FA",
      "editor.selectionBackground": "#54AEFF66",
      "editor.inactiveSelectionBackground": "#54AEFF4D",
      "editorCursor.foreground": "#0969DA",
      "editorWhitespace.foreground": "#AFB8C1",
      "editorIndentGuide.background1": "#D8DEE4",
      "editorBracketMatch.background": "#DDF4FF",
      "editorBracketMatch.border": "#54AEFF"
    }
  });
  monaco.editor.defineTheme("fastwrite-github-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8B949E" },
      { token: "keyword", foreground: "FF7B72" },
      { token: "keyword.control", foreground: "D2A8FF", fontStyle: "bold" },
      { token: "type", foreground: "79C0FF" },
      { token: "string", foreground: "A5D6FF" },
      { token: "string.escape", foreground: "7EE787" },
      { token: "operator", foreground: "D2A8FF" }
    ],
    colors: {
      "editor.background": "#0D1117",
      "editor.foreground": "#C9D1D9",
      "editorGutter.background": "#0D1117",
      "editorLineNumber.foreground": "#6E7681",
      "editorLineNumber.activeForeground": "#C9D1D9",
      "editor.lineHighlightBackground": "#161B22",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#264F7855",
      "editorCursor.foreground": "#58A6FF",
      "editorWhitespace.foreground": "#30363D",
      "editorIndentGuide.background1": "#21262D",
      "editorBracketMatch.background": "#1F3B5B",
      "editorBracketMatch.border": "#58A6FF"
    }
  });
}

export function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".tex") || lower.endsWith(".sty") || lower.endsWith(".cls") || lower.endsWith(".bib")) return "latex";
  return "plaintext";
}
