import { describe, expect, test } from "bun:test";
import { parseLatexOutline } from "./outline";

describe("parseLatexOutline", () => {
  test("builds a hierarchy and ignores commented sections", () => {
    const outline = parseLatexOutline(String.raw`\section{Introduction}
\subsection{Motivation}
% \section{Hidden}
\section*{Evaluation}`, "main.tex");
    expect(outline).toHaveLength(2);
    expect(outline[0]?.title).toBe("Introduction");
    expect(outline[0]?.children[0]?.title).toBe("Motivation");
    expect(outline[1]?.title).toBe("Evaluation");
  });

  test("parses multiline section titles", () => {
    const outline = parseLatexOutline("\\section{A multiline\n  title}\nText", "main.tex");
    expect(outline[0]).toMatchObject({ title: "A multiline title", line: 1 });
  });
});
