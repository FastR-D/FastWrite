import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export interface AuthenticatedIdentity {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  username?: string;
  groups: string[];
  emailVerified: boolean;
}

export interface LoginStart {
  returnTo?: string;
}

export interface LoginRedirect {
  kind: "redirect";
  url: string;
  binding?: string;
}

export interface LocalLoginResult {
  kind: "local";
}

export interface LoginCallback {
  code?: string;
  state?: string;
  ticket?: string;
}

/** Business services depend on this port, never directly on OIDC or CAS claims. */
export interface IdentityProvider {
  beginLogin(input: LoginStart): Promise<LoginRedirect | LocalLoginResult>;
  finishLogin(input: LoginCallback): Promise<AuthenticatedIdentity>;
  logout(sessionId: string): Promise<void>;
  loginReturnTo?(state?: string): string | undefined;
}

export interface OidcProviderConfiguration {
  issuer: string;
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
  scopes?: string[];
}

export interface CasProviderConfiguration {
  serverUrl: string;
  serviceUrl: string;
  attributeMapping?: { email?: string; displayName?: string; username?: string; groups?: string };
}

interface OidcDiscovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; }
interface LoginState { id: string; nonce: string; returnTo?: string; expiresAt: number; }
interface OidcJwk { kid?: string; kty?: string; use?: string; n?: string; e?: string; alg?: string; }

/**
 * Standards-only OIDC adapter. State is signed and its PKCE verifier is derived
 * server-side, so no IdP credential or verifier is placed in the browser.
 */
export class OidcIdentityProvider implements IdentityProvider {
  private discovery?: Promise<OidcDiscovery>;
  private readonly stateSecret = randomBytes(32);

  constructor(private readonly configuration: OidcProviderConfiguration, private readonly request: typeof fetch = fetch) {
    const issuer = new URL(configuration.issuer);
    const redirect = new URL(configuration.redirectUri);
    if (issuer.protocol !== "https:" || redirect.protocol !== "https:") throw new Error("OIDC issuer and redirect URI must use HTTPS");
  }

  async beginLogin(input: LoginStart): Promise<LoginRedirect> {
    const discovery = await this.loadDiscovery();
    const state: LoginState = { id: randomBytes(24).toString("base64url"), nonce: randomBytes(24).toString("base64url"), ...(safeReturnTo(input.returnTo) ? { returnTo: input.returnTo } : {}), expiresAt: Date.now() + 10 * 60_000 };
    const verifier = this.verifier(state.id);
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.configuration.clientId);
    url.searchParams.set("redirect_uri", this.configuration.redirectUri);
    url.searchParams.set("scope", (this.configuration.scopes?.length ? this.configuration.scopes : ["openid", "profile", "email"]).join(" "));
    const binding = this.signState(state);
    url.searchParams.set("state", binding);
    url.searchParams.set("nonce", state.nonce);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url"));
    return { kind: "redirect", url: url.toString(), binding };
  }

  async finishLogin(input: LoginCallback): Promise<AuthenticatedIdentity> {
    if (!input.code || !input.state) throw new Error("OIDC callback requires code and state");
    const state = this.verifyState(input.state);
    if (state.expiresAt < Date.now()) throw new Error("OIDC login state has expired");
    const discovery = await this.loadDiscovery();
    const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: this.configuration.redirectUri, client_id: this.configuration.clientId, code_verifier: this.verifier(state.id) });
    if (this.configuration.clientSecret) body.set("client_secret", this.configuration.clientSecret);
    const response = await this.request(discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    if (!response.ok) throw new Error("OIDC token exchange failed");
    const token = await response.json() as { id_token?: string };
    if (!token.id_token) throw new Error("OIDC response did not include an ID token");
    const claims = await this.verifyIdToken(token.id_token, discovery, state.nonce);
    const subject = stringClaim(claims.sub); if (!subject) throw new Error("OIDC ID token has no subject");
    const email = stringClaim(claims.email); const displayName = stringClaim(claims.name); const username = stringClaim(claims.preferred_username);
    return { issuer: discovery.issuer, subject, ...(email ? { email } : {}), ...(displayName ? { displayName } : {}), ...(username ? { username } : {}), groups: stringClaims(claims.groups), emailVerified: claims.email_verified === true };
  }

  async logout(_sessionId: string): Promise<void> { /* Local session revocation is owned by AuthService. */ }
  loginReturnTo(state?: string): string | undefined { return state ? this.verifyState(state).returnTo : undefined; }

  private async loadDiscovery(): Promise<OidcDiscovery> {
    this.discovery ??= (async () => {
      const issuer = this.configuration.issuer.replace(/\/$/, "");
      const response = await this.request(`${issuer}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("OIDC discovery failed");
      const value = await response.json() as Partial<OidcDiscovery>;
      if (value.issuer !== issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) throw new Error("OIDC discovery document is incomplete or has an unexpected issuer");
      for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri]) if (new URL(endpoint).protocol !== "https:") throw new Error("OIDC endpoints must use HTTPS");
      return value as OidcDiscovery;
    })();
    return this.discovery;
  }

  private async verifyIdToken(raw: string, discovery: OidcDiscovery, nonce: string): Promise<Record<string, unknown>> {
    const [headerPart, payloadPart, signaturePart, ...extra] = raw.split(".");
    if (!headerPart || !payloadPart || !signaturePart || extra.length) throw new Error("OIDC ID token is malformed");
    const header = decodeJson(headerPart); const claims = decodeJson(payloadPart);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("OIDC ID token uses an unsupported signing algorithm");
    const jwksResponse = await this.request(discovery.jwks_uri, { headers: { accept: "application/json" } });
    if (!jwksResponse.ok) throw new Error("OIDC JWKS retrieval failed");
    const jwks = await jwksResponse.json() as { keys?: OidcJwk[] };
    const jwk = jwks.keys?.find((item) => item.kid === header.kid && item.kty === "RSA" && item.use !== "enc");
    if (!jwk) throw new Error("OIDC signing key was not found");
    const key = await crypto.subtle.importKey("jwk", jwk as unknown as Record<string, unknown>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signaturePart, "base64url"), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
    if (!valid || claims.iss !== discovery.issuer || !audienceIncludes(claims.aud, this.configuration.clientId) || claims.nonce !== nonce || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("OIDC ID token validation failed");
    return claims;
  }

  private verifier(id: string): string { return createHmac("sha256", this.stateSecret).update(`pkce:${id}`).digest("base64url"); }
  private signState(state: LoginState): string { const encoded = Buffer.from(JSON.stringify(state)).toString("base64url"); return `${encoded}.${createHmac("sha256", this.stateSecret).update(encoded).digest("base64url")}`; }
  private verifyState(raw: string): LoginState { const [encoded, signature, ...extra] = raw.split("."); const expected = encoded && createHmac("sha256", this.stateSecret).update(encoded).digest("base64url"); if (!encoded || !signature || extra.length || !expected || !same(signature, expected)) throw new Error("OIDC login state is invalid"); const state = decodeJson(encoded); if (typeof state.id !== "string" || typeof state.nonce !== "string" || typeof state.expiresAt !== "number" || !safeReturnTo(state.returnTo)) throw new Error("OIDC login state is invalid"); return state as unknown as LoginState; }
}

/** CAS 3.0 adapter that keeps CAS-specific XML and attributes outside business services. */
export class CasIdentityProvider implements IdentityProvider {
  private readonly parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
  private readonly stateSecret = randomBytes(32);

  constructor(private readonly configuration: CasProviderConfiguration, private readonly request: typeof fetch = fetch) {
    if (new URL(configuration.serverUrl).protocol !== "https:" || new URL(configuration.serviceUrl).protocol !== "https:") throw new Error("CAS server and service URLs must use HTTPS");
  }

  async beginLogin(_input: LoginStart): Promise<LoginRedirect> {
    const binding = this.signState({ id: randomBytes(24).toString("base64url"), expiresAt: Date.now() + 10 * 60_000 });
    const service = new URL(this.configuration.serviceUrl); service.searchParams.set("state", binding);
    const url = new URL("login", normalizedBaseUrl(this.configuration.serverUrl));
    url.searchParams.set("service", service.toString());
    return { kind: "redirect", url: url.toString(), binding };
  }

  async finishLogin(input: LoginCallback): Promise<AuthenticatedIdentity> {
    if (!input.ticket || input.ticket.length > 8_192 || !input.state) throw new Error("CAS callback requires a service ticket and state");
    this.verifyState(input.state);
    const service = new URL(this.configuration.serviceUrl); service.searchParams.set("state", input.state);
    const url = new URL("p3/serviceValidate", normalizedBaseUrl(this.configuration.serverUrl));
    url.searchParams.set("service", service.toString());
    url.searchParams.set("ticket", input.ticket);
    const response = await this.request(url, { headers: { accept: "application/xml, text/xml" } });
    if (!response.ok) throw new Error("CAS service ticket validation failed");
    const document = this.parser.parse(await response.text()) as Record<string, unknown>;
    const root = asObject(document.serviceResponse); const success = root && asObject(root.authenticationSuccess);
    const user = success && stringValue(success.user);
    if (!user) throw new Error("CAS authentication was rejected");
    const attributes = asObject(success?.attributes) ?? {};
    const mapping = this.configuration.attributeMapping ?? {};
    const email = mappedAttribute(attributes, mapping.email ?? "email");
    const displayName = mappedAttribute(attributes, mapping.displayName ?? "displayName");
    const username = mappedAttribute(attributes, mapping.username ?? "username") ?? user;
    const groups = mappedAttributes(attributes, mapping.groups ?? "groups");
    return { issuer: normalizedBaseUrl(this.configuration.serverUrl).replace(/\/$/, ""), subject: user, ...(email ? { email } : {}), ...(displayName ? { displayName } : {}), username, groups, emailVerified: Boolean(email) };
  }

  async logout(_sessionId: string): Promise<void> { /* CAS single logout requires a deployment callback endpoint. */ }
  private signState(state: { id: string; expiresAt: number }): string { const encoded = Buffer.from(JSON.stringify(state)).toString("base64url"); return `${encoded}.${createHmac("sha256", this.stateSecret).update(encoded).digest("base64url")}`; }
  private verifyState(raw: string): void { const [encoded, signature, ...extra] = raw.split("."); const expected = encoded && createHmac("sha256", this.stateSecret).update(encoded).digest("base64url"); if (!encoded || !signature || extra.length || !expected || !same(signature, expected)) throw new Error("CAS login state is invalid"); const state = decodeJson(encoded); if (typeof state.id !== "string" || typeof state.expiresAt !== "number" || state.expiresAt < Date.now()) throw new Error("CAS login state is invalid"); }
}

function decodeJson(part: string): Record<string, unknown> { try { const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new Error("OIDC token is malformed"); } }
function same(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function safeReturnTo(value: unknown): value is string | undefined { return value === undefined || (typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && value.length <= 2_000); }
function stringClaim(value: unknown): string | undefined { return typeof value === "string" && value.length <= 320 ? value : undefined; }
function stringClaims(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 200) : []; }
function audienceIncludes(value: unknown, clientId: string): boolean { return value === clientId || (Array.isArray(value) && value.includes(clientId)); }
function normalizedBaseUrl(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
function asObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { if (typeof value === "string") return value.trim() || undefined; if (Array.isArray(value)) return stringValue(value[0]); return undefined; }
function mappedAttribute(attributes: Record<string, unknown>, name: string): string | undefined { return stringValue(attributes[name]); }
function mappedAttributes(attributes: Record<string, unknown>, name: string): string[] { const value = attributes[name]; const items = Array.isArray(value) ? value : value === undefined ? [] : [value]; return items.flatMap((item) => typeof item === "string" ? item.split(/[;,]/) : []).map((item) => item.trim()).filter(Boolean).slice(0, 200); }
