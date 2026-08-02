import { expect, test } from "bun:test";
import { inferCompletionIntent } from "./completion-service";

test("completion intent follows file type and cursor context", () => {
  expect(inferCompletionIntent("references.bib", "@article{")).toBe("citation");
  expect(inferCompletionIntent("main.tex", "The loss is $L = ")).toBe("formula");
  expect(inferCompletionIntent("main.tex", "\\cite{")).toBe("latex");
  expect(inferCompletionIntent("main.tex", "Our system prevents replay attacks. ")).toBe("sentence");
});
