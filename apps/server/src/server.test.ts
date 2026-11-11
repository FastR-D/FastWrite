import { expect, test } from "bun:test";
import { createServerOptions } from "./server";

test("keeps long Agent HTTP requests alive until the operation deadline", () => {
  const options = createServerOptions(async () => new Response("ok"));

  expect(options.idleTimeout).toBe(0);
});


test("preserves HTTPS origin checks behind the explicitly trusted loopback proxy", async () => {
  const prior = process.env.FASTWRITE_TRUST_PROXY;
  const received: string[] = [];
  const options = createServerOptions(async request => {
    received.push(await request.text());
    return new Response("ok", { status: request.headers.get("origin") === new URL(request.url).origin ? 200 : 403 });
  });
  const makeRequest = (origin = "https://write.fastrd.io") => new Request("http://write.fastrd.io/api/auth/fastcas/link", {
    method: "POST", headers: { origin, "x-forwarded-proto": "https", "content-type": "application/json" }, body: '{"password":"test-only"}'
  });
  try {
    delete process.env.FASTWRITE_TRUST_PROXY;
    expect((await options.fetch(makeRequest(), {} as never))?.status).toBe(403);
    process.env.FASTWRITE_TRUST_PROXY = "true";
    expect((await options.fetch(makeRequest(), {} as never))?.status).toBe(200);
    expect((await options.fetch(makeRequest("https://attacker.example"), {} as never))?.status).toBe(403);
    expect(received).toEqual(Array(3).fill('{"password":"test-only"}'));
  } finally {
    if (prior === undefined) delete process.env.FASTWRITE_TRUST_PROXY;
    else process.env.FASTWRITE_TRUST_PROXY = prior;
  }
});
