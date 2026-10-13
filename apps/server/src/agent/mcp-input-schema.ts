import { isDeepStrictEqual } from "node:util";
import { ApiError } from "../http";

type Schema = Record<string, unknown>;
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const keywords = new Set(["type", "title", "description", "default", "examples", "required", "properties", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems"]);
const object = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
function invalidSchema(): never { throw new ApiError(503, "mcp_schema_invalid", "Tool input schema contains an invalid or unsupported constraint"); }
function invalidInput(): never { throw new ApiError(400, "mcp_input_invalid", "Tool input does not satisfy its schema"); }

export function validateMcpInput(input: unknown, schema: Schema): void {
  checkSchema(schema, 0);
  checkInput(input, schema, 0);
}

function checkSchema(schema: unknown, depth: number): asserts schema is Schema {
  if (!object(schema) || depth > 32 || Object.keys(schema).some(key => !keywords.has(key))) invalidSchema();
  if (schema.type !== undefined && (typeof schema.type !== "string" || !types.has(schema.type))) invalidSchema();
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string"))) invalidSchema();
  if (schema.properties !== undefined) {
    if (!object(schema.properties)) invalidSchema();
    for (const child of Object.values(schema.properties)) checkSchema(child, depth + 1);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") checkSchema(schema.additionalProperties, depth + 1);
  if (schema.items !== undefined) checkSchema(schema.items, depth + 1);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) invalidSchema();
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const limit = schema[key];
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)) invalidSchema();
  }
  for (const key of ["minimum", "maximum"]) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) invalidSchema();
  for (const [min, max] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"]] as const) {
    if (typeof schema[min] === "number" && typeof schema[max] === "number" && schema[min] > schema[max]) invalidSchema();
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") invalidSchema();
    try { new RegExp(schema.pattern, "u"); } catch { invalidSchema(); }
  }
}

function checkInput(value: unknown, schema: Schema, depth: number): void {
  if (depth > 64) invalidInput();
  const type = schema.type;
  if (type !== undefined) {
    const valid = type === "object" ? object(value) : type === "array" ? Array.isArray(value) : type === "null" ? value === null : type === "integer" ? typeof value === "number" && Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;
    if (!valid) invalidInput();
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => isDeepStrictEqual(candidate, value))) invalidInput();
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(schema.const, value)) invalidInput();
  if (object(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, key))) invalidInput();
    const properties = object(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) checkInput(child, properties[key] as Schema, depth + 1);
      else if (schema.additionalProperties === false) invalidInput();
      else if (object(schema.additionalProperties)) checkInput(child, schema.additionalProperties, depth + 1);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems || typeof schema.maxItems === "number" && value.length > schema.maxItems) invalidInput();
    if (object(schema.items)) for (const item of value) checkInput(item, schema.items, depth + 1);
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (typeof schema.minLength === "number" && length < schema.minLength || typeof schema.maxLength === "number" && length > schema.maxLength) invalidInput();
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) invalidInput();
  }
  if (typeof value === "number" && (typeof schema.minimum === "number" && value < schema.minimum || typeof schema.maximum === "number" && value > schema.maximum)) invalidInput();
}
