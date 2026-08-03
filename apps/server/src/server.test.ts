import { expect, test } from "bun:test";
import { createServerOptions } from "./server";

test("keeps long Agent HTTP requests alive until the operation deadline", () => {
  const options = createServerOptions(async () => new Response("ok"));

  expect(options.idleTimeout).toBe(0);
});
