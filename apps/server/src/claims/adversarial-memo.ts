import type { PaperClaim, ClaimRelation } from "@fastwrite/shared";

export interface AdversarialMemo { id: string; projectId: string; advisory: true; strongestRejection: string; objections: Array<{ id: string; kind: "supported" | "contested" | "missing-evidence" | "style-only" | "argument-gap"; message: string; claimIds: string[]; anchorPaths: string[]; selectable: true }>; createdAt: string; }
export function buildAdversarialMemo(projectId: string, claims: PaperClaim[], relations: ClaimRelation[]): AdversarialMemo {
  const active = claims.filter((claim) => claim.anchorStatus !== "stale" && claim.anchorStatus !== "orphaned");
  const byId = new Map(active.map((claim) => [claim.id, claim]));
  const objections: AdversarialMemo["objections"] = relations.filter(r => r.status !== "stale" && r.type === "supports" && byId.get(r.fromClaimId)?.reviewStatus !== "supported").map(r => ({ id: `objection_${r.id}`, kind: "missing-evidence", message: "This argument link is not backed by a confirmed claim or approved evidence.", claimIds: [r.fromClaimId, r.toClaimId], anchorPaths: [byId.get(r.fromClaimId)?.anchor.path, byId.get(r.toClaimId)?.anchor.path].filter((path): path is string => Boolean(path)), selectable: true }));
  for (const claim of active.filter((item) => item.reviewStatus === "unsupported" || item.reviewStatus === "partial")) objections.push({ id: `objection_claim_${claim.id}`, kind: "contested", message: `The ${claim.type} claim is ${claim.reviewStatus} and should be challenged before submission.`, claimIds: [claim.id], anchorPaths: [claim.anchor.path], selectable: true });
  const strongestRejection = objections.length ? "The manuscript contains claims whose evidence or argument links remain unconfirmed." : "No evidence-bounded rejection reason was found in the current claim ledger.";
  return { id: `memo_${crypto.randomUUID()}`, projectId, advisory: true, strongestRejection, objections, createdAt: new Date().toISOString() };
}
