import { expect, test } from "bun:test";
import { OidcIdentityProvider } from "./identity-provider";

test("OIDC provider validates PKCE flow, nonce, issuer, audience and RS256 JWKS signature", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as Record<string, unknown>;
  publicJwk.kid = "test-key"; publicJwk.use = "sig";
  let nonce = "";
  let verifiedCodeVerifier = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/openid-configuration") return json({ issuer: "https://idp.example.test", authorization_endpoint: "https://idp.example.test/authorize", token_endpoint: "https://idp.example.test/token", jwks_uri: "https://idp.example.test/jwks" });
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      verifiedCodeVerifier = body.get("code_verifier")?.length === 43 && body.get("code") === "authorization-code";
      return json({ id_token: await signedToken(pair.privateKey, { iss: "https://idp.example.test", sub: "stable-subject", aud: "fastwrite", nonce, exp: Math.floor(Date.now() / 1000) + 60, email: "researcher@example.test", email_verified: true, name: "Researcher" }) });
    }
    if (url.pathname === "/jwks") return json({ keys: [publicJwk] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const provider = new OidcIdentityProvider({ issuer: "https://idp.example.test", clientId: "fastwrite", redirectUri: "https://fastwrite.example.test/api/auth/oidc/callback" }, fetcher);
  const start = await provider.beginLogin({ returnTo: "/projects" });
  const redirect = new URL(start.url); nonce = redirect.searchParams.get("nonce")!;
  const identity = await provider.finishLogin({ code: "authorization-code", state: redirect.searchParams.get("state")! });
  expect(verifiedCodeVerifier).toBe(true);
  expect(identity).toMatchObject({ issuer: "https://idp.example.test", subject: "stable-subject", email: "researcher@example.test", emailVerified: true });
  await expect(provider.finishLogin({ code: "authorization-code", state: "forged" })).rejects.toThrow("OIDC login state is invalid");
});

async function signedToken(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
