import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "./Field";
import { MultiSelect } from "./MultiSelect";
import { TextField } from "../primitives/TextField";

/*
 * `children` goes inside the props object rather than as createElement's third
 * argument: FieldProps.children is required, and React's createElement overloads
 * reject a props object that omits a required prop even when the child is passed
 * positionally. The rendered markup is identical either way.
 */
describe("Field wiring", () => {
  test("a control inside a Field inherits id and aria-describedby", () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: "Project name",
        hint: "Shown in the list.",
        children: createElement(TextField, { value: "x" })
      })
    );
    // The label points at the control, and the control points back at the hint.
    const forId = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
    expect(forId).toBeTruthy();
    expect(html).toContain(`id="${forId}"`);
    expect(html).toContain(`aria-describedby="${forId}-hint"`);
  });

  test("an explicit id wins over the Field's", () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: "Project name",
        children: createElement(TextField, { id: "custom", value: "x" })
      })
    );
    expect(html).toContain('id="custom"');
  });

  test("an error marks the control invalid", () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: "Path",
        error: "Use a managed path.",
        children: createElement(TextField, { value: "" })
      })
    );
    expect(html).toContain('aria-invalid="true"');
  });

  test("a control outside any Field renders without wiring", () => {
    const html = renderToStaticMarkup(createElement(TextField, { value: "x" }));
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("aria-invalid");
  });

  test("MultiSelect's checkboxes do not inherit the Field's id", () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: "Skills",
        children: createElement(MultiSelect, {
          label: "Skills", value: [], onChange: () => {},
          options: [{ value: "a", label: "A" }, { value: "b", label: "B" }]
        })
      })
    );
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
