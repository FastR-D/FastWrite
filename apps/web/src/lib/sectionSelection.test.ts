import { describe, expect, test } from "bun:test";
import type { FileContentResponse, OutlineItem } from "@fastwrite/shared";
import { currentParagraphSelection, currentSectionSelection } from "./sectionSelection";

test("a section selection includes its subsections until the next peer section", () => {
  const content = "\\section{One}\nA\n\\subsection{Child}\nB\n\\section{Two}\nC";
  const document = { file: { path: "main.tex", name: "main.tex", kind: "text", size: content.length, version: 1, updatedAt: "" }, content } satisfies FileContentResponse;
  const outline: OutlineItem[] = [{ id: "1", title: "One", level: 1, path: "main.tex", line: 1, children: [{ id: "2", title: "Child", level: 2, path: "main.tex", line: 3, children: [] }] }, { id: "3", title: "Two", level: 1, path: "main.tex", line: 5, children: [] }];
  expect(currentSectionSelection(document, outline, { path: "main.tex", line: 2 })?.text).toBe("\\section{One}\nA\n\\subsection{Child}\nB");
});

test("the final section selection ends exactly at the document boundary", () => {
  const content = "\\section{Only}\nLast line";
  const document = { file: { path: "main.tex", name: "main.tex", kind: "text", size: content.length, version: 2, updatedAt: "" }, content } satisfies FileContentResponse;
  const outline: OutlineItem[] = [{ id: "1", title: "Only", level: 1, path: "main.tex", line: 1, children: [] }];
  const selection = currentSectionSelection(document, outline, { path: "main.tex", line: 2 });
  expect(selection?.text).toBe(content);
  expect(selection?.to).toBe(content.length);
});

test("a paragraph selection is bounded by blank lines", () => {
  const content = "First paragraph.\nStill first.\n\nSecond paragraph with evidence.\nStill second.\n\nThird.";
  const document = { file: { path: "main.tex", name: "main.tex", kind: "text", size: content.length, version: 3, updatedAt: "" }, content } satisfies FileContentResponse;
  const selection = currentParagraphSelection(document, { path: "main.tex", line: 4 });
  expect(selection?.text).toBe("Second paragraph with evidence.\nStill second.");
  expect(selection).toMatchObject({ startLine: 4, endLine: 5, fileVersion: 3 });
});

test("a blank cursor line does not select adjacent paragraphs", () => {
  const content = "First.\n\nSecond.";
  const document = { file: { path: "main.tex", name: "main.tex", kind: "text", size: content.length, version: 1, updatedAt: "" }, content } satisfies FileContentResponse;
  expect(currentParagraphSelection(document, { path: "main.tex", line: 2 })).toBeNull();
});
