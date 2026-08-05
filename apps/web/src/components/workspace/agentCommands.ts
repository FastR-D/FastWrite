import type { AgentTaskIntent, AgentTaskPlan, ChangeSet } from "@fastwrite/shared";

export const AGENT_INTENT_COMMANDS: ReadonlyArray<{ intent: AgentTaskIntent; label: string }> = [
  { intent: "draft", label: "/draft" },
  { intent: "continue", label: "/continue" },
  { intent: "revise", label: "/revise" }
];

export function applyAgentIntentCommand(objective: string, intent: AgentTaskIntent): string {
  const remainder = objective.trimStart().replace(/^\/(?:draft|continue|revise)\b\s*/i, "").trimStart();
  return `/${intent}${remainder ? ` ${remainder}` : " "}`;
}

export function activeAgentIntentCommand(objective: string): AgentTaskIntent | null {
  const intent = objective.trimStart().match(/^\/(draft|continue|revise)\b/i)?.[1]?.toLowerCase();
  return intent === "draft" || intent === "continue" || intent === "revise" ? intent : null;
}

export function recoverableAgentPlan<T extends Pick<AgentTaskPlan, "id" | "status" | "changeSetId">>(plans: T[], dismissedPlanId: string | null): T | undefined {
  return plans.find((plan) => plan.id !== dismissedPlanId && (plan.status === "proposed" || plan.status === "waiting-approval"));
}

export function restoredAgentReviewStage(changeSet: Pick<ChangeSet, "status">): "diff" | null {
  return changeSet.status === "proposed" || changeSet.status === "partially-accepted" ? "diff" : null;
}

export function activeAgentChangeSetStage(changeSet: Pick<ChangeSet, "status">): "diff" | "accepted" | null {
  if (changeSet.status === "accepted") return "accepted";
  return restoredAgentReviewStage(changeSet);
}
