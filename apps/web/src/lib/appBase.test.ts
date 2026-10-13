import { describe, expect, test } from "bun:test";
import { appPath, normalizeAppBase, relativeAppPath } from "./appBase";

describe("deployment path", () => {
  test("root and nested routes share one prefix", () => {
    expect(normalizeAppBase("/")).toBe("");
    expect(normalizeAppBase("/write/")).toBe("/write");
    expect(appPath("/api/projects", "/write")).toBe("/write/api/projects");
    expect(appPath("/write/api/projects", "/write")).toBe("/write/api/projects");
    expect(appPath("/projects/a", "")).toBe("/projects/a");
    expect(appPath("/writer/projects", "/write")).toBe("/write/writer/projects");
  });
  test("external links and fragments keep their targets", () => {
    for (const path of ["https://example.com/paper", "//example.com/paper", "#workflow", "mailto:author@example.com"]) {
      expect(appPath(path, "/write")).toBe(path);
    }
  });
  test("router strips only its own complete path segment", () => {
    expect(relativeAppPath("/write/projects/a", "/write")).toBe("/projects/a");
    expect(relativeAppPath("/write/", "/write")).toBe("/");
    expect(relativeAppPath("/writer/projects/a", "/write")).toBe("/writer/projects/a");
  });
});
