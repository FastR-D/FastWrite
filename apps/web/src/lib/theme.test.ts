import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("theme imports in a real Node process without a DOM or controller initialization", () => {
  const result = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    assert.equal(process.release.name, 'node');
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
    const theme = await import(${JSON.stringify(new URL("./theme.ts", import.meta.url).href)});
    assert.equal(theme.currentTheme(), 'light');
    assert.equal(typeof theme.initTheme, 'function');
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
  `], { encoding: "utf8", timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  expect(result.status).toBe(0);
});
