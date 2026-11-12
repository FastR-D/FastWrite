/** Provision fixture users through the administrator API, then sign in locally. */
export async function provisionAccount(app: (request: Request) => Promise<Response>, request: Request, administrator: { email: string; password: string } | { token: string }): Promise<Response> {
  const origin = new URL(request.url).origin;
  const input = await request.json() as { email: string; password: string; displayName?: string };
  const post = (path: string, body: unknown, token?: string) => app(new Request(origin + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  const token = "token" in administrator ? administrator.token : (await (await post("/api/auth/login", administrator)).json() as { token: string }).token;
  const created = await post("/api/admin/users", { ...input, displayName: input.displayName || input.email.split("@")[0], platformRole: "user", status: "active", reason: "Provision account for integration test" }, token);
  if (!created.ok) throw new Error(`Fixture provisioning failed: ${await created.text()}`);
  const login = await post("/api/auth/login", input);
  return new Response(login.body, { status: 201, headers: login.headers });
}
