import { describe, expect, test } from "bun:test";
import { normalizePublicationTarget } from "./models";

describe("publication targets", () => {
  test("normalizes a venue and its supported track", () => {
    expect(normalizePublicationTarget({ domain: "artificial-intelligence", venueId: "acl", year: 2027, stage: "submission", track: "short" }, "artificial-intelligence")).toEqual({ domain: "artificial-intelligence", venueId: "acl", year: 2027, stage: "submission", track: "short" });
  });

  test("rejects profile mismatches and normalizes invalid stages", () => {
    expect(normalizePublicationTarget({ domain: "network-information-security", venueId: "ccs", stage: "submission" }, "artificial-intelligence")).toBeUndefined();
    expect(normalizePublicationTarget({ domain: "artificial-intelligence", venueId: "jmlr", stage: "invalid" }, "artificial-intelligence")).toEqual({ domain: "artificial-intelligence", venueId: "jmlr", stage: "submission" });
  });
});
