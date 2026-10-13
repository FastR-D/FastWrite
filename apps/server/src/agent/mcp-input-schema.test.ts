import { expect, test } from "bun:test";
import { validateMcpInput } from "./mcp-input-schema";

test("required false, zero and null values are valid and nested arrays enforce bounds", () => {
  const schema = { type: "object", required: ["enabled", "count", "empty", "tags"], additionalProperties: false, properties: {
    enabled: { type: "boolean" }, count: { type: "integer", minimum: 0, maximum: 2 }, empty: { type: "null" },
    tags: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", pattern: "^[a-z]+$", minLength: 1 } }
  } };
  expect(() => validateMcpInput({ enabled: false, count: 0, empty: null, tags: ["text"] }, schema)).not.toThrow();
  for (const tags of [[], ["bad-tag"], [1], ["a", "b", "c"]]) expect(() => validateMcpInput({ enabled: false, count: 0, empty: null, tags }, schema)).toThrow();
  expect(() => validateMcpInput({ enabled: false, count: 0.5, empty: null, tags: ["a"] }, schema)).toThrow();
});

test("schema constraints are checked even inside unused properties", () => {
  for (const child of [{ pattern: "[" }, { type: "invalid" }, { maxLength: -1 }, { required: "field" }, { maxItems: 1, minItems: 2 }, { unknownConstraint: true }]) {
    try { validateMcpInput({}, { type: "object", properties: { unused: child } }); throw new Error("Expected schema rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "mcp_schema_invalid", status: 503 }); }
  }
});
