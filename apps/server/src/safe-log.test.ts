import { describe, expect, test } from "bun:test";
import { logServerError } from "./safe-log";

describe("privacy-safe server logging", () => {
  test("records only error classification and never message, stack, key, or paper text", () => {
    const previous = console.error;
    const calls: unknown[][] = [];
    console.error = (...values: unknown[]) => { calls.push(values); };
    try {
      const error = Object.assign(new Error("sk-secret-key Full private paper paragraph"), { code: "EACCES" });
      logServerError("request failed", error);
    } finally {
      console.error = previous;
    }
    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("request failed");
    expect(serialized).toContain("EACCES");
    expect(serialized).not.toContain("sk-secret-key");
    expect(serialized).not.toContain("private paper");
  });
});
