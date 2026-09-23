import { createHash, randomBytes } from "node:crypto";
import { FastCAS, type Configuration, type Link, type TransactionStore } from "@fastrd/fastcas/server";
import type { JsonDatabase } from "../storage/database";
import { ApiError } from "../http";
import type { AuthResult, AuthService, Principal } from "./auth-service";
export type FastCASConfiguration = Configuration & { allowRegistration?: boolean };

export class FastCASTransactions implements TransactionStore {
  constructor(private readonly database: JsonDatabase) {}
  async put(transaction: Parameters<TransactionStore["put"]>[0]) {
    await this.database.mutate(state => {
      state.fastcasTransactions = state.fastcasTransactions.filter(item => item.expiresAt > Date.now());
      if (state.fastcasTransactions.some(item => item.state === transaction.state)) throw new Error("Duplicate login transaction");
      state.fastcasTransactions.push(transaction);
    });
  }
  async take(id: string) {
    return this.database.mutate(state => {
      const transaction = state.fastcasTransactions.find(item => item.state === id);
      state.fastcasTransactions = state.fastcasTransactions.filter(item => item.state !== id && item.expiresAt > Date.now());
      return transaction;
    });
  }
}

/** Optional provider: construction does not contact FastCAS. Local login and
 * project ACLs do not depend on this service or on central availability. */
export class FastCASService {
  readonly sdk: FastCAS;
  private readonly revocationListeners = new Set<() => void>();
  onRevocation(listener: () => void) { this.revocationListeners.add(listener); return () => { this.revocationListeners.delete(listener); }; }
  private notifyRevocation() { for (const listener of this.revocationListeners) listener(); }
  constructor(readonly configuration: FastCASConfiguration, private readonly database: JsonDatabase, private readonly auth: AuthService) {
    this.sdk = new FastCAS(configuration, new FastCASTransactions(database));
  }
  status(principal: Principal) {
    return { enabled: true, issuer: this.configuration.issuer, proof: this.auth.fastCASProofStatus(principal), links: this.database.snapshot().fastcasLinks.filter(item => item.userId === principal.user.id && item.issuer === this.configuration.issuer).map(item => item.link) };
  }
  async setLocalPassword(principal: Principal, password: string) {
    return this.auth.setLocalPasswordFromFastCAS(principal, this.configuration.issuer, password);
  }
  async beginLogin(returnTo = "/projects") {
    const binding = randomBytes(32).toString("base64url");
    return { binding, url: await this.sdk.beginLogin({ browserBinding: binding, returnTo }) };
  }
  async beginRegistration(returnTo = "/projects") {
    if (!this.configuration.allowRegistration) throw new ApiError(403, "fastcas_signup_disabled", "Creating accounts with FastCAS is not enabled");
    const binding = randomBytes(32).toString("base64url");
    const newLocalAccountRef = `user_${crypto.randomUUID()}`;
    return { binding, url: await this.sdk.beginRegistration({ browserBinding: binding, newLocalAccountRef, returnTo }) };
  }
  async beginLink(principal: Principal, password: string, returnTo = "/projects") {
    await this.auth.proveFastCASAccount(principal, password);
    if (this.database.snapshot().fastcasLinks.some(item => item.userId === principal.user.id && item.issuer === this.configuration.issuer && item.link.state !== "revoked")) throw new ApiError(409, "fastcas_link_exists", "An authentication is already active or pending; reconcile it first");
    const binding = randomBytes(32).toString("base64url");
    return { binding, url: await this.sdk.beginLink({ browserBinding: binding, localAccountRef: principal.user.id, localSessionId: principal.sessionId, returnTo }) };
  }
  async callback(url: URL, binding: string, refreshCookie: string): Promise<{ returnTo: string; result?: AuthResult }> {
    const tx = this.database.snapshot().fastcasTransactions.find(item => item.state === url.searchParams.get("state"));
    if (!tx) throw new ApiError(401, "fastcas_transaction_invalid", "Login expired or already used");
    if (tx.purpose === "register" && !this.configuration.allowRegistration) throw new ApiError(403, "fastcas_signup_disabled", "Creating accounts with FastCAS is not enabled");
    if (tx.purpose === "link") {
      const state = this.database.snapshot();
      const local = state.sessions.find(item => item.id === tx.localSessionId && item.userId === tx.localAccountRef && !item.revokedAt && item.expiresAt > new Date().toISOString() && item.refreshTokenHash === hash(refreshCookie));
      if (!local || !state.users.some(user => user.id === local.userId && user.status === "active")) throw new ApiError(401, "fastcas_local_session_changed", "Your local account changed; start authentication again");
    }
    const verified = await this.sdk.finishLogin(url, { browserBinding: binding, ...(tx.localAccountRef ? { localAccountRef: tx.localAccountRef } : {}), ...(tx.localSessionId ? { localSessionId: tx.localSessionId } : {}) });
    if (verified.transaction.purpose === "link" || verified.transaction.purpose === "register") {
      const prepared = await this.sdk.prepareLink(verified);
      await this.database.mutate(state => {
        const localId = tx.localAccountRef!;
        if (prepared.local_account_ref !== localId) throw new ApiError(409, "fastcas_binding_conflict", "The returned account reference does not match");
        if (tx.purpose === "register") {
          if (state.users.some(user => user.id === localId)) throw new ApiError(409, "fastcas_account_exists", "Registration cannot associate an existing local account");
          const now = new Date().toISOString();
          // Unverified email claims must not inherit email-based invitations.
          const email = verified.identity.emailVerified && verified.identity.email ? verified.identity.email.trim().toLowerCase() : `${localId}@identity.invalid`;
          state.users.push({ id: localId, emailNormalized: email, displayName: (verified.identity.name || "FastCAS user").slice(0,100), platformRole: "user", status: "active", authzVersion: 1, createdAt: now, updatedAt: now });
          state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: localId, action: "auth.fastcas_register", resourceType: "user", resourceId: localId, createdAt: now });
        } else {
          const local = state.sessions.find(item => item.id === tx.localSessionId && !item.revokedAt && item.expiresAt > new Date().toISOString());
          if (!local || local.userId !== localId || !state.users.some(user => user.id === localId && user.status === "active")) throw new ApiError(401, "fastcas_local_session_changed", "Local session expired");
        }
        const conflict = state.fastcasLinks.some(item => item.issuer === this.configuration.issuer && item.link.id !== prepared.id && item.link.state !== "revoked" && (item.userId === localId || item.link.subject === prepared.subject));
        if (conflict) throw new ApiError(409, "fastcas_binding_conflict", "This account or identity is already linked");
        state.fastcasLinks.push({ issuer: this.configuration.issuer, userId: localId, link: prepared });
      });
      // Durable pending mapping precedes remote activation. A lost response can
      // be reconciled using the same link ID without creating another account.
      const active = await this.sdk.activateLink(prepared.id);
      await this.saveLink(active);
      return { returnTo: verified.transaction.returnTo, ...(tx.purpose === "register" ? { result: await this.auth.loginFastCAS(verified.identity, active) } : {}) };
    }
    const pending = this.database.snapshot().fastcasLinks.find(item => item.issuer === this.configuration.issuer && item.link.subject === verified.identity.subject && item.link.state === "prepared");
    if (pending) {
      let remote = await this.sdk.getLink(pending.link.id);
      if (remote.state === "prepared") remote = await this.sdk.activateLink(remote.id);
      await this.saveLink(remote);
    }
    const link = await this.sdk.resolveLink(verified.identity.subject);
    return { returnTo: verified.transaction.returnTo, result: await this.auth.loginFastCAS(verified.identity, link) };
  }
  async reconcile(principal: Principal, id: string) {
    const existing = this.owned(principal, id);
    let remote = await this.sdk.getLink(existing.id);
    if (remote.state === "prepared") remote = await this.sdk.activateLink(remote.id);
    await this.saveLink(remote);
    return remote;
  }
  async revoke(principal: Principal, password: string, id: string) {
    await this.auth.proveFastCASAccount(principal, password);
    const link = this.owned(principal, id);
    const revoked = await this.sdk.revokeLink(link);
    await this.saveLink(revoked);
    return revoked;
  }
  async handleEvent(raw: string) {
    await this.sdk.handleNotification(raw, async event => {
      await this.database.mutate(state => {
        if (state.fastcasEvents.some(item => item.id === event.id && item.issuer === this.configuration.issuer)) return;
        if (event.type === "account_link.revoked") applyLink(state, this.configuration.issuer, event.link);
        else if (event.status === "disabled") {
          const links = new Set(state.fastcasLinks.filter(item => item.issuer === this.configuration.issuer && item.link.subject === event.subject).map(item => item.link.id));
          const now = new Date().toISOString();
          for (const session of state.sessions) if (session.authSource === "fastcas" && session.casIssuer === this.configuration.issuer && session.casLinkId && links.has(session.casLinkId)) session.revokedAt ??= now;
        }
        state.fastcasEvents.push({ id: event.id, issuer: this.configuration.issuer, processedAt: new Date().toISOString() });
        state.fastcasEvents = state.fastcasEvents.filter(item => Date.parse(item.processedAt) > Date.now() - 30 * 86400_000);
      });
      this.notifyRevocation();
    });
  }
  async handleLogout(raw: string) {
    const notice = await this.sdk.verifyLogout(raw);
    await this.database.mutate(state => {
      if (state.fastcasEvents.some(item => item.id === notice.id && item.issuer === this.configuration.issuer)) return;
      const links = new Set(state.fastcasLinks.filter(item => item.issuer === this.configuration.issuer && item.link.subject === notice.subject).map(item => item.link.id));
      const now = new Date().toISOString();
      for (const session of state.sessions) {
        if (session.authSource === "fastcas" && session.casIssuer === this.configuration.issuer &&
          session.casLinkId && links.has(session.casLinkId) && (!notice.sessionId || session.casSid === notice.sessionId)) session.revokedAt ??= now;
      }
      state.fastcasEvents.push({ id: notice.id, issuer: this.configuration.issuer, processedAt: now });
    });
    this.notifyRevocation();
  }
  private owned(principal: Principal, id: string): Link {
    const link = this.database.snapshot().fastcasLinks.find(item => item.userId === principal.user.id && item.issuer === this.configuration.issuer && item.link.id === id)?.link;
    if (!link) throw new ApiError(404, "fastcas_link_missing", "Authentication not found");
    return link;
  }
  private async saveLink(link: Link) { await this.database.mutate(state => applyLink(state, this.configuration.issuer, link)); if (link.state === "revoked") this.notifyRevocation(); }
}

function applyLink(state: ReturnType<JsonDatabase["snapshot"]>, issuer: string, link: Link) {
  const item = state.fastcasLinks.find(item => item.issuer === issuer && item.link.id === link.id && item.userId === link.local_account_ref && item.link.subject === link.subject);
  if (!item || item.link.version > link.version || item.link.state === "revoked") return;
  item.link = link;
  const now = new Date().toISOString();
  if (link.state === "revoked") for (const session of state.sessions) if (session.authSource === "fastcas" && session.casIssuer === issuer && session.casLinkId === link.id) session.revokedAt ??= now;
  state.auditEvents.push({ id: `audit_${crypto.randomUUID()}`, actorUserId: item.userId, action: `auth.fastcas.${link.state}`, resourceType: "account_link", resourceId: link.id, createdAt: now });
}
function hash(raw: string) { return createHash("sha256").update(raw).digest("hex"); }
