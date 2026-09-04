import { normalizeWorkspacePath, type ClaimAnchor, type ClaimEvidenceLink, type PaperClaim, type SourceEvidence } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase, DatabaseState } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";

const CLAIM_VERB = /\b(?:shows?|demonstrates?|improves?|reduces?|increases?|achieves?|outperforms?)\b/i;
const now = () => new Date().toISOString();
type ClaimEvidenceLinkInput =
  | Omit<Extract<ClaimEvidenceLink, { kind: "literature" }>, "id" | "claimId">
  | Omit<Extract<ClaimEvidenceLink, { kind: "workspace" }>, "id" | "claimId">
  | Omit<Extract<ClaimEvidenceLink, { kind: "review-waiver" }>, "id" | "claimId">;
type OpenedClaimFile = { content: string; version: number } | null;

export class ClaimService {
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService) {}

  async scan(projectId: string): Promise<PaperClaim[]> {
    const project = this.workspaces.getProject(projectId);
    await this.refresh(projectId);
    const paths = textPaths(await this.workspaces.tree(projectId));
    const found: PaperClaim[] = [];

    for (const path of [project.mainDocument, ...paths.filter((candidate) => candidate !== project.mainDocument)]) {
      const file = await this.workspaces.readTextFile(projectId, path);
      const occurrences = new Map<string, number>();
      for (const match of file.content.matchAll(/[^.!?\n]+[.!?]/g)) {
        const exactText = match[0].trim();
        if (exactText.length < 20 || !isClaimCandidate(exactText)) continue;
        const normalizedText = exactText.replace(/\s+/g, " ").trim();
        const occurrence = occurrences.get(normalizedText) ?? 0;
        occurrences.set(normalizedText, occurrence + 1);
        const startOffset = (match.index ?? 0) + match[0].indexOf(exactText);
        const anchor: ClaimAnchor = {
          path,
          fileVersion: file.file.version,
          startOffset,
          endOffset: startOffset + exactText.length,
          exactText,
          prefix: file.content.slice(Math.max(0, startOffset - 40), startOffset),
          suffix: file.content.slice(startOffset + exactText.length, startOffset + exactText.length + 40)
        };
        const numbers = [...exactText.matchAll(/(-?\d+(?:\.\d+)?)\s*(%|ms|s|×|x|points?)?/gi)].map((item) => ({ raw: item[0], normalized: Number(item[1]), ...(item[2] ? { unit: item[2] } : {}) }));
        const timestamp = now();
        found.push({
          id: stableClaimId(projectId, path, normalizedText, occurrence),
          projectId,
          anchor,
          type: claimType(exactText),
          surface: hasCitation(exactText) ? "citation" : hasNumericClaim(exactText) ? "number" : /caption/i.test(path) ? "caption" : "text",
          normalizedText,
          ...(numbers.length ? { numbers } : {}),
          reviewStatus: "detected",
          anchorStatus: "current",
          createdBy: "scanner",
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }
    }

    return this.database.mutate((state) => {
      const previous = state.paperClaims.filter((claim) => claim.projectId === projectId);
      const matched = new Set<string>();
      const merged = found.map((claim) => {
        const existing = previous.find((candidate) => !matched.has(candidate.id) && (candidate.id === claim.id || anchorsMatch(candidate.anchor, claim.anchor)));
        if (!existing) return claim;
        matched.add(existing.id);
        return { ...claim, id: existing.id, reviewStatus: existing.reviewStatus, anchorStatus: existing.anchorStatus === "reanchored" ? "reanchored" as const : "current" as const, createdBy: existing.createdBy, createdAt: existing.createdAt };
      });
      const retained = previous.filter((claim) => !matched.has(claim.id));
      state.paperClaims = state.paperClaims.filter((claim) => claim.projectId !== projectId);
      state.paperClaims.push(...merged, ...retained);
      for (const claim of [...merged, ...retained]) ensureClaimSupport(state, claim);
      return [...merged, ...retained];
    });
  }

  async list(projectId: string): Promise<PaperClaim[]> {
    await this.refresh(projectId);
    return this.database.snapshot().paperClaims.filter((claim) => claim.projectId === projectId);
  }

  links(projectId: string): ClaimEvidenceLink[] {
    this.workspaces.getProject(projectId);
    const state = this.database.snapshot();
    const claimIds = new Set(state.paperClaims.filter((claim) => claim.projectId === projectId).map((claim) => claim.id));
    return state.claimEvidenceLinks.filter((link) => claimIds.has(link.claimId));
  }

  async refresh(projectId: string): Promise<PaperClaim[]> {
    this.workspaces.getProject(projectId);
    const snapshot = this.database.snapshot();
    const current = snapshot.paperClaims.filter((claim) => claim.projectId === projectId);
    if (!current.length) return [];
    const currentIds = new Set(current.map((claim) => claim.id));
    const workspaceEvidencePaths = snapshot.claimEvidenceLinks.filter((link): link is Extract<ClaimEvidenceLink, { kind: "workspace" }> => link.kind === "workspace" && currentIds.has(link.claimId)).map((link) => link.path);
    const files = new Map<string, OpenedClaimFile>();
    for (const path of new Set([...current.map((claim) => claim.anchor.path), ...workspaceEvidencePaths])) {
      try {
        if (!await this.workspaces.fileExists(projectId, path)) { files.set(path, null); continue; }
        const opened = await this.workspaces.readTextFile(projectId, path);
        files.set(path, { content: opened.content, version: opened.file.version });
      } catch { files.set(path, null); }
    }
    return this.database.mutate((state) => {
      const claims = state.paperClaims.filter((claim) => claim.projectId === projectId);
      const claimIds = new Set(claims.map((claim) => claim.id));
      for (const link of state.claimEvidenceLinks) {
        if (link.kind !== "workspace" || !claimIds.has(link.claimId)) continue;
        const file = files.get(link.path) ?? null;
        link.stale = !file || file.version !== link.anchor.fileVersion || file.content.slice(link.anchor.startOffset, link.anchor.endOffset) !== link.anchor.exactText;
      }
      for (const claim of claims) { refreshClaimAnchor(claim, files.get(claim.anchor.path) ?? null); ensureClaimSupport(state, claim); }
      return claims;
    });
  }

  async renamePath(projectId: string, from: string, to: string): Promise<void> {
    this.workspaces.getProject(projectId);
    const source = normalizeWorkspacePath(from);
    const target = normalizeWorkspacePath(to);
    await this.database.mutate((state) => {
      for (const claim of state.paperClaims.filter((item) => item.projectId === projectId && (item.anchor.path === source || item.anchor.path.startsWith(`${source}/`)))) { claim.anchor.path = `${target}${claim.anchor.path.slice(source.length)}`; claim.anchorStatus = "stale"; claim.updatedAt = now(); }
      for (const link of state.claimEvidenceLinks) if (link.kind === "workspace" && (link.path === source || link.path.startsWith(`${source}/`))) { link.path = `${target}${link.path.slice(source.length)}`; link.anchor.path = `${target}${link.anchor.path.slice(source.length)}`; }
    });
    await this.refresh(projectId);
  }

  async deletePath(projectId: string, path: string): Promise<void> {
    this.workspaces.getProject(projectId);
    const deleted = normalizeWorkspacePath(path);
    await this.database.mutate((state) => {
      for (const claim of state.paperClaims.filter((item) => item.projectId === projectId && (item.anchor.path === deleted || item.anchor.path.startsWith(`${deleted}/`)))) markClaimOrphaned(claim);
      for (const claim of state.paperClaims.filter((item) => item.projectId === projectId)) ensureClaimSupport(state, claim);
    });
  }

  async reanchor(projectId: string, claimId: string): Promise<PaperClaim> {
    await this.refresh(projectId);
    const claim = this.database.snapshot().paperClaims.find((item) => item.projectId === projectId && item.id === claimId);
    if (!claim) throw new ApiError(404, "claim_not_found", "Claim not found");
    return claim;
  }

  async update(projectId: string, claimId: string, updates: Partial<Pick<PaperClaim, "reviewStatus">>): Promise<PaperClaim> {
    await this.refresh(projectId);
    if (updates.reviewStatus && !new Set(["detected", "needs-review", "supported", "partial", "unsupported"]).has(updates.reviewStatus)) throw new ApiError(400, "claim_status_invalid", "Claim review status is invalid");
    return this.database.mutate((state) => {
      const claim = state.paperClaims.find((item) => item.projectId === projectId && item.id === claimId);
      if (!claim) throw new ApiError(404, "claim_not_found", "Claim not found");
      if (updates.reviewStatus === "supported") {
        if (claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned") throw new ApiError(409, "claim_anchor_invalid", "Reanchor the claim before marking it supported");
        if (!hasValidSupport(state, claim.id)) throw new ApiError(409, "claim_evidence_required", "A claim cannot be marked supported without approved evidence or a user waiver");
      }
      if (updates.reviewStatus) claim.reviewStatus = updates.reviewStatus;
      claim.updatedAt = now();
      return claim;
    });
  }

  async link(projectId: string, claimId: string, link: ClaimEvidenceLinkInput): Promise<ClaimEvidenceLink> {
    this.workspaces.getProject(projectId);
    let checked = link;
    if (link.kind === "workspace") {
      const path = normalizeWorkspacePath(link.path);
      const opened = await this.workspaces.readTextFile(projectId, path);
      if (link.anchor.path !== path || link.anchor.fileVersion !== opened.file.version || opened.content.slice(link.anchor.startOffset, link.anchor.endOffset) !== link.anchor.exactText) throw new ApiError(409, "workspace_evidence_stale", "Workspace evidence must match the current file version and exact text");
      checked = { ...link, path, anchor: { ...link.anchor, path }, stale: false };
    } else if (link.kind === "review-waiver") {
      const reason = link.reason.trim();
      if (link.approvedByUser !== true || reason.length < 8) throw new ApiError(400, "waiver_requires_user", "Review waiver requires explicit user approval and a reason");
      checked = { ...link, reason };
    }
    return this.database.mutate((state) => {
      if (!state.paperClaims.some((claim) => claim.projectId === projectId && claim.id === claimId)) throw new ApiError(404, "claim_not_found", "Claim not found");
      if (checked.kind === "literature" && !state.sourceEvidence.some((evidence) => evidence.id === checked.evidenceId && evidence.projectId === projectId)) throw new ApiError(400, "evidence_not_found", "Evidence does not belong to this project");
      const duplicate = state.claimEvidenceLinks.find((candidate) => candidate.claimId === claimId && candidate.kind === checked.kind && (candidate.kind !== "literature" || checked.kind !== "literature" || candidate.evidenceId === checked.evidenceId));
      if (duplicate) return duplicate;
      const created = { ...checked, id: `claim_link_${crypto.randomUUID()}`, claimId } as ClaimEvidenceLink;
      state.claimEvidenceLinks.push(created);
      return created;
    });
  }

  async unlink(projectId: string, claimId: string, linkId: string): Promise<void> {
    this.workspaces.getProject(projectId);
    await this.database.mutate((state) => {
      const claim = state.paperClaims.find((item) => item.projectId === projectId && item.id === claimId);
      if (!claim) throw new ApiError(404, "claim_not_found", "Claim not found");
      state.claimEvidenceLinks = state.claimEvidenceLinks.filter((link) => !(link.claimId === claimId && link.id === linkId));
      ensureClaimSupport(state, claim);
    });
  }

  async updateEvidence(projectId: string, evidenceId: string, status?: SourceEvidence["status"]): Promise<SourceEvidence> {
    this.workspaces.getProject(projectId);
    if (status && !new Set(["candidate", "approved", "rejected", "stale"]).has(status)) throw new ApiError(400, "evidence_status_invalid", "Evidence status is invalid");
    return this.database.mutate((state) => {
      const evidence = state.sourceEvidence.find((item) => item.projectId === projectId && item.id === evidenceId);
      if (!evidence) throw new ApiError(404, "evidence_not_found", "Evidence not found");
      if (status) evidence.status = status;
      if (status === "approved") evidence.approvedAt = now(); else if (status) delete evidence.approvedAt;
      evidence.updatedAt = now();
      const claimIds = new Set(state.claimEvidenceLinks.filter((link) => link.kind === "literature" && link.evidenceId === evidenceId).map((link) => link.claimId));
      for (const claim of state.paperClaims.filter((item) => claimIds.has(item.id))) ensureClaimSupport(state, claim);
      return evidence;
    });
  }
}

function refreshClaimAnchor(claim: PaperClaim, file: OpenedClaimFile): void {
  if (!file) { markClaimOrphaned(claim); return; }
  const previous = claim.anchor;
  const exactOffset = closestExactOffset(file.content, previous.exactText, previous.startOffset);
  if (exactOffset >= 0) {
    const changed = file.version !== previous.fileVersion || exactOffset !== previous.startOffset;
    claim.anchor = anchorAt(previous.path, file.content, file.version, exactOffset, previous.exactText);
    claim.anchorStatus = changed || claim.anchorStatus === "reanchored" ? "reanchored" : "current";
    if (changed) claim.updatedAt = now();
    return;
  }
  const contextual = contextCandidate(file.content, previous);
  if (contextual) {
    claim.anchor = anchorAt(previous.path, file.content, file.version, contextual.startOffset, contextual.exactText);
    claim.anchorStatus = "reanchored";
    if (claim.reviewStatus === "supported") claim.reviewStatus = "needs-review";
    claim.updatedAt = now();
    return;
  }
  markClaimOrphaned(claim);
}

function markClaimOrphaned(claim: PaperClaim): void { if (claim.anchorStatus !== "orphaned") claim.updatedAt = now(); claim.anchorStatus = "orphaned"; if (claim.reviewStatus === "supported") claim.reviewStatus = "needs-review"; }

function anchorAt(path: string, content: string, fileVersion: number, startOffset: number, exactText: string): ClaimAnchor { return { path, fileVersion, startOffset, endOffset: startOffset + exactText.length, exactText, prefix: content.slice(Math.max(0, startOffset - 40), startOffset), suffix: content.slice(startOffset + exactText.length, startOffset + exactText.length + 40) }; }

function closestExactOffset(content: string, exactText: string, expected: number): number { let best = -1; let distance = Number.POSITIVE_INFINITY; for (let offset = content.indexOf(exactText); offset >= 0; offset = content.indexOf(exactText, offset + 1)) { const nextDistance = Math.abs(offset - expected); if (nextDistance < distance) { best = offset; distance = nextDistance; } } return best; }

function contextCandidate(content: string, anchor: ClaimAnchor): { startOffset: number; exactText: string } | null {
  if (!anchor.prefix && !anchor.suffix) return null;
  const expectedPrefix = Math.max(0, anchor.startOffset - anchor.prefix.length);
  const prefixIndex = anchor.prefix ? closestExactOffset(content, anchor.prefix, expectedPrefix) : 0;
  if (prefixIndex < 0) return null;
  const startOffset = anchor.prefix ? prefixIndex + anchor.prefix.length : 0;
  const suffixIndex = anchor.suffix ? content.indexOf(anchor.suffix, startOffset) : content.length;
  if (suffixIndex < startOffset) return null;
  const exactText = content.slice(startOffset, suffixIndex);
  if (exactText.length < 20 || exactText.length > 1000 || !isClaimCandidate(exactText)) return null;
  return { startOffset, exactText };
}

function anchorsMatch(previous: ClaimAnchor, detected: ClaimAnchor): boolean { if (previous.path !== detected.path || previous.exactText !== detected.exactText) return false; return Math.abs(previous.startOffset - detected.startOffset) <= 4 || Math.max(previous.startOffset, detected.startOffset) < Math.min(previous.endOffset, detected.endOffset); }

function hasValidSupport(state: DatabaseState, claimId: string): boolean { return state.claimEvidenceLinks.some((link) => link.claimId === claimId && (link.kind === "review-waiver" || (link.kind === "workspace" && !link.stale) || (link.kind === "literature" && state.sourceEvidence.some((evidence) => evidence.id === link.evidenceId && evidence.status === "approved")))); }

function ensureClaimSupport(state: DatabaseState, claim: PaperClaim): void { if (claim.reviewStatus === "supported" && (claim.anchorStatus === "stale" || claim.anchorStatus === "orphaned" || !hasValidSupport(state, claim.id))) { claim.reviewStatus = "needs-review"; claim.updatedAt = now(); } }

function stableClaimId(projectId: string, path: string, exactText: string, occurrence: number): string { const digest = new Bun.CryptoHasher("sha256").update(`${projectId}\u0000${path}\u0000${exactText}\u0000${occurrence}`).digest("hex"); return `claim_${digest.slice(0, 24)}`; }

function hasCitation(text: string): boolean { return /\\(?:cite|citep|citet|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{[^}]+\}/i.test(text); }

function hasNumericClaim(text: string): boolean { return /-?\d+(?:\.\d+)?\s*(?:%|points?)/i.test(text); }

function isClaimCandidate(text: string): boolean { return CLAIM_VERB.test(text) || hasCitation(text) || hasNumericClaim(text); }

function claimType(text: string): PaperClaim["type"] { return /contribution|propose|introduce/i.test(text) ? "contribution" : /method|algorithm|model/i.test(text) ? "method" : /limitation|cannot|future work/i.test(text) ? "limitation" : /result|improv|reduc|increase|outperform|-?\d+(?:\.\d+)?\s*(?:%|points?)/i.test(text) ? "result" : "background"; }

function textPaths(nodes: any[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" && /\.tex$/i.test(node.path) ? [node.path] : []); }
