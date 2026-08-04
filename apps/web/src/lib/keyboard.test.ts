import { describe, expect, test } from "bun:test";
import { isSaveShortcut } from "./keyboard";

describe("global save shortcut", () => {
  test("accepts Ctrl+S and Cmd+S without browser-only modifiers", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "S", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "s", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });
});
