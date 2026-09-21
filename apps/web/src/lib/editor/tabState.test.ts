import { expect, test } from "bun:test";
import { openSourceTab, pinSourceTab } from "./tabState";
test("preview replacement preserves pinned buffers and editing fixes a preview", () => {
  let tabs = openSourceTab([], "a.tex");
  tabs = openSourceTab(tabs, "b.tex");
  expect(tabs.map(tab => tab.path)).toEqual(["b.tex"]);
  tabs = pinSourceTab(tabs, "b.tex");
  tabs = openSourceTab(tabs, "c.tex");
  tabs = openSourceTab(tabs, "d.tex");
  expect(tabs).toEqual([{ path: "b.tex", pinned: true }, { path: "d.tex", pinned: false }]);
  expect(openSourceTab(tabs, "b.tex")).toBe(tabs);
  expect(openSourceTab(tabs, "d.tex", true).every(tab => tab.pinned)).toBe(true);
});
