import { expect, test } from "bun:test";
import {
  buildLatexIndex,
  parseBibtex,
  searchBibliography,
  citationSlot,
} from "./latex-intelligence";
const doc = (content: string, path = "refs.bib") => ({
  path,
  content,
  version: 1,
});
test("BibTeX parses balanced fields, quoted braces, strings, concatenation, crossref and comments", () => {
  const parsed = parseBibtex(
    doc(String.raw`% @article{fake,title={not real}}
@string{venue = "Conference " # {on AI}}
@proceedings{parent, booktitle = venue, year = 2026}
@inproceedings{Smith:2026, title = {A {Nested} \textit{Title} with \{braces\}}, author="Smith, Alice and Doe, Bob", crossref={parent}, doi={10.123/a}}
@article(other, title="Quoted {title} and \"escape\"", year=2025)
@comment{ignore @article{x,title={no}}}`),
  );
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.entries.map((item) => item.key)).toEqual([
    "parent",
    "Smith:2026",
    "other",
  ]);
  expect(parsed.entries[1]!.fields).toMatchObject({
    booktitle: "Conference on AI",
    year: "2026",
    doi: "10.123/a",
  });
  expect(
    searchBibliography(parsed.entries, "alice 2026").map((item) => item.key),
  ).toEqual(["Smith:2026"]);
});
test("duplicate keys and malformed entries are reported rather than silently accepted", () => {
  const index = buildLatexIndex([
    doc("@article{x,title={First}}"),
    doc("@book{x,title={Second}}", "other.bib"),
  ]);
  expect(
    index.diagnostics.filter((item) => item.message.includes("重复")).length,
  ).toBe(2);
  expect(
    parseBibtex(doc("@article{broken,title={unterminated")).entries,
  ).toEqual([]);
});
test("project macros and labels exclude comments", () => {
  const index = buildLatexIndex([
    doc(
      String.raw`% \label{fake}
\newcommand{\method}{FastWrite}
\NewDocumentCommand{\score}{m}{#1}
\newenvironment{claim}{start}{end}
\label{sec:method}`,
      "main.tex",
    ),
  ]);
  expect(index.symbols.map((item) => item.name)).toEqual([
    "method",
    "score",
    "claim",
    "sec:method",
  ]);
});
test("citation slot supports optional arguments and multiple keys without replacing the command", () => {
  const text = String.raw`See \citep[see][p. 2]{a, b} and text.`;
  const slot = citationSlot(text, text.indexOf("b}"));
  expect(slot?.keys).toEqual(["a", "b"]);
  expect(text.slice(slot!.from, slot!.to)).toBe("a, b");
  expect(citationSlot("% \\cite{x}", 9)).toBeNull();
  expect(citationSlot("\\section{title}", 12)).toBeNull();
});

test("citation slot never treats bibliography style settings as citation keys", () => {
  expect(citationSlot("\\citestyle{numeric}", 15)).toBeNull();
});
