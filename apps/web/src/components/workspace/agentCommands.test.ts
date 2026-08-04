import { describe, expect, test } from "bun:test";
import { activeAgentIntentCommand, applyAgentIntentCommand, recoverableAgentPlan } from "./agentCommands";

describe("Agent intent command buttons", () => {
  test("insert and replace an intent without discarding the objective", () => {
    expect(applyAgentIntentCommand("", "draft")).toBe("/draft ");
    expect(applyAgentIntentCommand("Write the initial paper", "continue")).toBe("/continue Write the initial paper");
    expect(applyAgentIntentCommand("/draft Write the initial paper", "revise")).toBe("/revise Write the initial paper");
    expect(applyAgentIntentCommand("  /CONTINUE finish the TODO", "draft")).toBe("/draft finish the TODO");
  });

  test("reports only supported leading commands as active", () => {
    expect(activeAgentIntentCommand(" /draft Write it")).toBe("draft");
    expect(activeAgentIntentCommand("/continue Finish it")).toBe("continue");
    expect(activeAgentIntentCommand("/revise Improve it")).toBe("revise");
    expect(activeAgentIntentCommand("Write it /draft")).toBeNull();
  });

  test("does not reopen older accepted history after starting a new task", () => {
    const plans = [
      { id: "latest", status: "accepted" as const, changeSetId: "change-latest" },
      { id: "older", status: "accepted" as const, changeSetId: "change-older" }
    ];
    expect(recoverableAgentPlan(plans, null)?.id).toBe("latest");
    expect(recoverableAgentPlan(plans, "latest")).toBeUndefined();
  });

  test("still restores unfinished work ahead of accepted history", () => {
    const plans = [
      { id: "accepted", status: "accepted" as const, changeSetId: "change-accepted" },
      { id: "pending", status: "waiting-approval" as const }
    ];
    expect(recoverableAgentPlan(plans, "accepted")?.id).toBe("pending");
  });
});
