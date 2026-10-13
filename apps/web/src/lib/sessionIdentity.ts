export const SESSION_CHANGED = "fastwrite-session-changed";
const tokenKey = "fastwrite.session-token";
const identityKey = "fastwrite.session-identity";
interface Identity { token: string; scope: string; userId?: string; }
const knownScopes = new Map<string, string>();

function storedIdentity(): Identity | undefined {
  try { const value = JSON.parse(localStorage.getItem(identityKey) ?? "null"); return value && typeof value.token === "string" && typeof value.scope === "string" ? value : undefined; }
  catch { return undefined; }
}

export function sessionIdentity(): { scope: string; token: string | null } {
  const token = localStorage.getItem(tokenKey);
  if (!token) return { scope: "local", token: null };
  const identity = storedIdentity();
  if (identity?.token === token) {
    knownScopes.set(token, identity.scope);
    return { scope: identity.scope, token };
  }
  let scope = knownScopes.get(token);
  if (!scope) {
    // A legacy/manual token has no trustworthy account mapping. Give it a new
    // namespace instead of inheriting another account's browser data.
    scope = `session:${crypto.randomUUID()}`;
    knownScopes.set(token, scope);
  }
  // Another tab can observe the two login storage writes separately. Never
  // overwrite a newer binding while it is still installing its access token.
  if (!identity) localStorage.setItem(identityKey, JSON.stringify({ token, scope }));
  return { scope, token };
}

export function rememberSession(session: { token: string; user?: { id: string } }, previousToken?: string): void {
  const previous = storedIdentity();
  const sameSession = previousToken && previous?.token === previousToken && (!previous.userId || !session.user || previous.userId === session.user.id);
  const identity: Identity = { token: session.token, scope: sameSession ? previous.scope : session.user ? `user:${session.user.id}` : `session:${crypto.randomUUID()}`, ...(session.user ? { userId: session.user.id } : {}) };
  knownScopes.set(session.token, identity.scope);
  localStorage.setItem(identityKey, JSON.stringify(identity));
  localStorage.setItem(tokenKey, session.token);
  window.dispatchEvent(new Event(SESSION_CHANGED));
}

export function captureSessionIdentity() {
  const captured = sessionIdentity();
  return { ...captured, current: () => sessionIdentity().scope === captured.scope };
}
