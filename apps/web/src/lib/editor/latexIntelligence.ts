import * as monaco from "./monacoRuntime";
import {
  buildLatexIndex,
  searchBibliography,
  withoutLatexComments,
  type LatexIndex,
} from "@fastwrite/shared";
import { api } from "../../api/client";
import type { DocumentRegistry } from "./documentRegistry";
import {
  TEX_COMMANDS,
  TEX_OPTIONS,
  TEX_ENVIRONMENTS,
  TEX_PACKAGES,
  TEX_CLASSES,
} from "./latexCatalog";

export class LatexIntelligence {
  private remote: LatexIndex | null = null;
  private fetchedAt = 0;
  private pending: Promise<void> | undefined;
  private disposed = false;
  constructor(
    readonly projectId: string,
    private readonly registry: DocumentRegistry,
  ) {}
  current(path: string) {
    const remote = this.remote?.documents.find((doc) => doc.path === path);
    const local = this.registry.get(path);
    return Boolean(
      remote && local && remote.version === local.session.serverVersion,
    );
  }
  dispose() {
    this.disposed = true;
    this.remote = null;
  }
  async index(force = false): Promise<LatexIndex> {
    if (this.disposed) throw new Error("编辑器已关闭");
    if (force && this.pending) await this.pending;
    if (force || Date.now() - this.fetchedAt > 3000) {
      this.pending ??= api.latex
        .index(this.projectId)
        .then((index) => {
          if (!this.disposed) {
            this.remote = index;
            this.fetchedAt = Date.now();
          }
        })
        .finally(() => {
          this.pending = undefined;
        });
      await this.pending;
    }
    const documents = new Map(
      (this.remote?.documents ?? []).map((doc) => [doc.path, doc]),
    );
    // Only overlay models still authorized by the latest server index.
    for (const entry of this.registry.entries.values())
      if (
        documents.get(entry.file.path)?.version ===
          entry.session.serverVersion &&
        !entry.model.isDisposed()
      )
        documents.set(entry.file.path, {
          path: entry.file.path,
          content: entry.model.getValue(),
          version: entry.session.serverVersion,
        });
    const index = buildLatexIndex(
      [...documents.values()],
      this.remote?.projectVersion ?? 0,
    );
    return {
      ...index,
      packages: this.remote?.packages ?? [],
      classes: this.remote?.classes ?? [],
      packageSymbols: this.remote?.packageSymbols ?? [],
    };
  }
}
export function installLatexProviders(
  projectId: string,
  intelligence: LatexIntelligence,
) {
  const owns = (model: monaco.editor.ITextModel) =>
    model.uri.scheme === "fastwrite" && model.uri.authority === projectId;
  const uri = (path: string) =>
    monaco.Uri.from({
      scheme: "fastwrite",
      authority: projectId,
      path: `/${path}`,
    });
  const disposables: monaco.IDisposable[] = [];
  disposables.push(
    monaco.languages.registerCompletionItemProvider("latex", {
      triggerCharacters: ["\\", "{", ",", "/", "["],
      async provideCompletionItems(model, position, _context, token) {
        if (!owns(model)) return { suggestions: [] };
        const modelVersion = model.getVersionId();
        const offset = model.getOffsetAt(position),
          before = withoutLatexComments(model.getValue().slice(0, offset));
        // Do not complete inside a TeX comment.
        const rawLine = model
          .getLineContent(position.lineNumber)
          .slice(0, position.column - 1);
        if (
          withoutLatexComments(rawLine).trimEnd().length <
          rawLine.trimEnd().length
        )
          return { suggestions: [] };
        let index: LatexIndex;
        try {
          index = await intelligence.index();
        } catch {
          return { suggestions: [] };
        }
        if (
          token.isCancellationRequested ||
          model.isDisposed() ||
          model.getVersionId() !== modelVersion
        )
          return { suggestions: [] };
        const suggestions: monaco.languages.CompletionItem[] = [];
        const add = (
          label: string,
          insertText: string,
          fragment: string,
          detail = "",
          snippet = false,
          kind = monaco.languages.CompletionItemKind.Function,
          consume = 0,
        ) => {
          suggestions.push({
            label,
            insertText,
            detail,
            kind,
            filterText: label,
            range: new monaco.Range(
              position.lineNumber,
              Math.max(1, position.column - fragment.length),
              position.lineNumber,
              position.column + consume,
            ),
            ...(snippet
              ? {
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet,
                }
              : {}),
          });
        };
        const option =
          /\\(documentclass|usepackage|RequirePackage|includegraphics|begin)\s*\[([^\]\n]*)$/.exec(
            before,
          );
        if (option) {
          const suffix = model.getValue().slice(offset),
            upcoming = /^[^\]\n]*\]\s*\{([^{}]+)\}/.exec(suffix)?.[1];
          const context =
            option[1] === "usepackage" || option[1] === "RequirePackage"
              ? (upcoming ?? "")
              : option[1]!;
          const fragment = option[2]!.split(",").at(-1)!.trimStart();
          for (const item of TEX_OPTIONS[context] ?? [])
            add(
              item.split("=")[0]!,
              item,
              fragment,
              "LaTeX 选项",
              item.includes("${"),
              monaco.languages.CompletionItemKind.Property,
            );
          return { suggestions };
        }
        const arg = /\\([a-zA-Z]+)\*?(?:\s*\[[^\]\n]*\])*\s*\{([^{}\n]*)$/.exec(
          before,
        );
        if (arg) {
          const name = arg[1]!,
            list = arg[2]!,
            fragment = list.split(",").at(-1)!.trimStart();
          if (
            /^(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|autocite|parencite|textcite|footcite|smartcite|supercite|nocite)$/i.test(
              name,
            )
          ) {
            const used = new Set(
              list
                .split(",")
                .slice(0, -1)
                .map((key) => key.trim()),
            );
            const counts = new Map<string, number>();
            index.entries.forEach((entry) =>
              counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1),
            );
            for (const entry of searchBibliography(index.entries, fragment))
              if (counts.get(entry.key) === 1 && !used.has(entry.key)) {
                add(
                  entry.key,
                  entry.key,
                  fragment,
                  `${entry.fields.author ?? ""} · ${entry.fields.title ?? ""} · ${entry.fields.year ?? entry.fields.date ?? ""}`,
                  false,
                  monaco.languages.CompletionItemKind.Reference,
                );
                suggestions.at(-1)!.filterText = `${fragment} ${entry.key}`;
              }
          } else if (
            /^(?:ref|eqref|pageref|autoref|cref|Cref|vref|label)$/.test(name)
          )
            for (const symbol of index.symbols.filter(
              (symbol) => symbol.kind === "label",
            ))
              add(
                symbol.name,
                symbol.name,
                fragment,
                `${symbol.path}:${symbol.line}`,
                false,
                monaco.languages.CompletionItemKind.Reference,
              );
          else if (name === "begin" || name === "end") {
            const stack: string[] = [];
            for (const match of before.matchAll(
              /\\(begin|end)\s*\{([^{}]+)\}/g,
            )) {
              if (match[1] === "begin") stack.push(match[2]!);
              else if (stack.at(-1) === match[2]) stack.pop();
            }
            const environments =
              name === "end" && stack.length
                ? [...stack].reverse()
                : [
                    ...new Set([
                      ...TEX_ENVIRONMENTS,
                      ...[...index.symbols, ...(index.packageSymbols ?? [])]
                        .filter((symbol) => symbol.kind === "environment")
                        .map((symbol) => symbol.name),
                    ]),
                  ];
            for (const env of environments) {
              const suffix = model.getValue().slice(offset);
              const paired =
                name === "begin" &&
                !suffix.slice(0, 500).includes(`\\end{${env}}`);
              add(
                env,
                paired ? `${env}}\n\t\${0}\n\\end{${env}}` : env,
                fragment,
                "LaTeX 环境",
                paired,
                monaco.languages.CompletionItemKind.Module,
                paired && suffix.startsWith("}") ? 1 : 0,
              );
            }
          } else if (name === "usepackage" || name === "RequirePackage")
            for (const pkg of new Set([
              ...TEX_PACKAGES,
              ...(index.packages ?? []),
              ...index.documents
                .filter((doc) => doc.path.endsWith(".sty"))
                .map((doc) => doc.path.replace(/\.sty$/, "")),
            ]))
              add(
                pkg,
                pkg,
                fragment,
                "宏包",
                false,
                monaco.languages.CompletionItemKind.Module,
              );
          else if (name === "documentclass")
            for (const cls of new Set([
              ...TEX_CLASSES,
              ...(index.classes ?? []),
              ...index.documents
                .filter((doc) => doc.path.endsWith(".cls"))
                .map((doc) => doc.path.replace(/\.cls$/, "")),
            ]))
              add(
                cls,
                cls,
                fragment,
                "文档类",
                false,
                monaco.languages.CompletionItemKind.Class,
              );
          else if (
            /^(input|include|includegraphics|bibliography|addbibresource)$/.test(
              name,
            )
          ) {
            const paths = await api.projects.tree(projectId);
            const flat = (nodes: any[]): string[] =>
              nodes.flatMap((node) =>
                node.type === "directory" ? flat(node.children) : [node.path],
              );
            for (const path of flat(paths)) {
              if (
                name === "includegraphics"
                  ? !/\.(pdf|png|jpg|jpeg|eps|svg)$/i.test(path)
                  : name === "bibliography" || name === "addbibresource"
                    ? !/\.bib$/i.test(path)
                    : !/\.tex$/i.test(path)
              )
                continue;
              const directory = model.uri.path
                .slice(1)
                .split("/")
                .slice(0, -1)
                .join("/");
              const relative = path;
              const value =
                name === "include" || name === "input"
                  ? relative.replace(/\.tex$/, "")
                  : name === "bibliography"
                    ? relative.replace(/\.bib$/, "")
                    : relative;
              add(
                value,
                value,
                fragment,
                path,
                false,
                monaco.languages.CompletionItemKind.File,
              );
            }
          }
          return { suggestions };
        }
        const command = /\\([A-Za-z@]*)$/.exec(before);
        if (command) {
          for (const item of TEX_COMMANDS)
            add(
              item.name,
              item.insert,
              command[1]!,
              item.detail,
              true,
              item.kind === "symbol"
                ? monaco.languages.CompletionItemKind.Constant
                : monaco.languages.CompletionItemKind.Function,
            );
          for (const symbol of [
            ...index.symbols,
            ...(index.packageSymbols ?? []),
          ].filter((symbol) => symbol.kind === "command"))
            add(
              symbol.name,
              symbol.name +
                Array.from(
                  { length: symbol.parameters ?? 0 },
                  (_, i) => `{\${${i + 1}}}`,
                ).join(""),
              command[1]!,
              `${symbol.path}:${symbol.line}`,
              Boolean(symbol.parameters),
            );
        } else if (model.uri.path.endsWith(".bib")) {
          const word = model.getWordUntilPosition(position).word;
          for (const name of [
            "article",
            "inproceedings",
            "book",
            "misc",
            "phdthesis",
            "techreport",
          ])
            add(
              `@${name}`,
              `@${name}{\${1:key},\n  author = {\${2}},\n  title = {\${3}},\n  year = {\${4}}\n}`,
              before.endsWith("@" + word) ? "@" + word : word,
              "BibTeX 条目",
              true,
            );
          for (const field of "author title year journal booktitle volume number pages publisher doi url eprint archiveprefix abstract keywords editor month note crossref".split(
            " ",
          ))
            add(
              field,
              `${field} = {\${1}},`,
              word,
              "BibTeX 字段",
              true,
              monaco.languages.CompletionItemKind.Field,
            );
        }
        return {
          suggestions: [
            ...new Map(suggestions.map((item) => [item.label, item])).values(),
          ],
        };
      },
    }),
  );
  const lookup = async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ) => {
    if (!owns(model)) return null;
    const index = await intelligence.index();
    const line = model.getLineContent(position.lineNumber),
      column = position.column - 1;
    let start = column,
      end = column;
    while (start > 0 && /[A-Za-z0-9_:./+@-]/.test(line[start - 1]!)) start--;
    while (end < line.length && /[A-Za-z0-9_:./+@-]/.test(line[end]!)) end++;
    const word = line.slice(start, end);
    if (!word) return null;
    const entry = index.entries.find((entry) => entry.key === word),
      symbol = [...index.symbols, ...(index.packageSymbols ?? [])].find(
        (symbol) => symbol.name === word,
      );
    return entry
      ? {
          path: entry.path,
          line: entry.line,
          text: [
            entry.key,
            entry.fields.title,
            entry.fields.author,
            entry.fields.year,
            entry.fields.doi,
          ]
            .filter(Boolean)
            .join("\n\n"),
        }
      : symbol
        ? {
            ...symbol,
            text: `${symbol.kind}: ${symbol.name}\n\n${symbol.path}:${symbol.line}`,
          }
        : null;
  };
  disposables.push(
    monaco.languages.registerHoverProvider("latex", {
      async provideHover(model, position) {
        try {
          const item = await lookup(model, position);
          return item
            ? {
                contents: [
                  { value: item.text.replace(/[\\`*_{}\[\]()#+!|>]/g, "\\$&") },
                ],
              }
            : null;
        } catch {
          return null;
        }
      },
    }),
  );
  disposables.push(
    monaco.languages.registerDefinitionProvider("latex", {
      async provideDefinition(model, position) {
        try {
          const item = await lookup(model, position);
          return item && !item.path.startsWith("@package/")
            ? {
                uri: uri(item.path),
                range: new monaco.Range(item.line, 1, item.line, 1),
              }
            : null;
        } catch {
          return null;
        }
      },
    }),
  );
  disposables.push(
    monaco.languages.registerFoldingRangeProvider("latex", {
      provideFoldingRanges(model) {
        if (!owns(model)) return [];
        const ranges: monaco.languages.FoldingRange[] = [],
          stack: Array<{ name: string; start: number }> = [],
          sections: Array<{ level: number; start: number }> = [];
        const names = [
          "part",
          "chapter",
          "section",
          "subsection",
          "subsubsection",
          "paragraph",
        ];
        for (let line = 1; line <= model.getLineCount(); line++) {
          const text = withoutLatexComments(model.getLineContent(line));
          const section =
            /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*\{/.exec(
              text,
            );
          if (section) {
            const level = names.indexOf(section[1]!);
            while (sections.length && sections.at(-1)!.level >= level) {
              const top = sections.pop()!;
              if (line - 1 > top.start)
                ranges.push({ start: top.start, end: line - 1 });
            }
            sections.push({ level, start: line });
          }
          for (const match of text.matchAll(/\\(begin|end)\s*\{([^{}]+)\}/g)) {
            if (match[1] === "begin")
              stack.push({ name: match[2]!, start: line });
            else if (stack.at(-1)?.name === match[2]) {
              const top = stack.pop()!;
              if (line > top.start)
                ranges.push({ start: top.start, end: line });
            }
          }
        }
        for (const section of sections)
          if (model.getLineCount() > section.start)
            ranges.push({ start: section.start, end: model.getLineCount() });
        return ranges;
      },
    }),
  );
  return () => disposables.forEach((item) => item.dispose());
}
