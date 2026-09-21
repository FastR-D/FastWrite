import { describe, expect, test } from "bun:test";
import { linkTarget } from "./Link";

describe("linkTarget", () => {
  test("treats in-app paths as internal navigation", () => {
    expect(linkTarget("/projects")).toEqual({ kind: "internal", href: "/projects" });
    expect(linkTarget("/projects/abc")).toEqual({ kind: "internal", href: "/projects/abc" });
  });

  test("treats hash anchors as on-page, not navigation", () => {
    expect(linkTarget("#workflow")).toEqual({ kind: "anchor", href: "#workflow" });
  });

  test("treats absolute URLs as external", () => {
    expect(linkTarget("https://example.com/x")).toEqual({ kind: "external", href: "https://example.com/x" });
    expect(linkTarget("http://example.com")).toEqual({ kind: "external", href: "http://example.com" });
  });

  test("treats mailto and protocol-relative as external", () => {
    expect(linkTarget("mailto:a@b.c")).toEqual({ kind: "external", href: "mailto:a@b.c" });
    expect(linkTarget("//cdn.example.com/x")).toEqual({ kind: "external", href: "//cdn.example.com/x" });
  });
});
