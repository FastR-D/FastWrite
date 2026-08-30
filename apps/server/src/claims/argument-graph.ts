import type { ClaimRelation, PaperClaim } from "@fastwrite/shared";

export function deriveArgumentGraph(projectId: string, claims: PaperClaim[]): ClaimRelation[] {
  const ordered = [...claims].filter(c => c.anchorStatus !== "orphaned").sort((a, b) => a.anchor.path.localeCompare(b.anchor.path) || a.anchor.startOffset - b.anchor.startOffset);
  const relations: ClaimRelation[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const from = ordered[index - 1]!, to = ordered[index]!;
    const type: ClaimRelation["type"] = from.type === "contribution" && to.type === "method" ? "implements" : from.type === "method" && to.type === "result" ? "evaluates" : from.type === "result" && to.type === "limitation" ? "limits" : from.type === "background" && to.type === "contribution" ? "motivates" : "supports";
    relations.push({ id: `relation_${from.id}_${to.id}`, projectId, fromClaimId: from.id, toClaimId: to.id, type, status: "candidate", origin: "scanner" });
  }
  return relations;
}
