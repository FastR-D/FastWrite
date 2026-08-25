import { describe, expect, test } from "bun:test";
import { WRITING_PROFILES, paperSkillForProfile } from "@fastwrite/shared";
import { join } from "node:path";
import { SkillRegistry } from "./skill-registry";

describe("SkillRegistry publication targets", () => {
  const registry = new SkillRegistry(join(import.meta.dir, "..", "skills"));
  const official2026: Record<string, string[]> = {
    "computer-architecture-systems": ["ppopp", "fast", "dac", "hpca", "micro", "sc", "asplos", "isca", "usenix-atc", "eurosys", "hpdc", "tocs", "tos", "tcad", "tc", "tpds", "taco"],
    "computer-networks": ["sigcomm", "mobicom", "infocom", "nsdi", "jsac", "tmc", "ton"],
    "network-information-security": ["ccs", "eurocrypt", "sp", "crypto", "usenix-security", "ndss", "tdsc", "tifs", "journal-of-cryptology"],
    "software-engineering-systems-languages": ["pldi", "popl", "fse", "sosp", "oopsla", "ase-conference", "icse", "issta", "osdi", "fm", "toplas", "tosem", "tse", "tsc"],
    "database-data-mining-retrieval": ["sigmod", "kdd", "icde", "sigir", "vldb", "tods", "tois", "tkde", "vldbj"],
    "theoretical-computer-science": ["stoc", "soda", "cav", "focs", "lics", "tit", "iandc", "sicomp"],
    "graphics-multimedia": ["acm-mm", "siggraph", "vr", "ieee-vis", "tog", "tip", "tvcg", "tmm"],
    "artificial-intelligence": ["aaai", "neurips", "acl", "cvpr", "iccv", "icml", "iclr", "artificial-intelligence", "tpami", "ijcv", "jmlr"],
    "human-computer-interaction": ["cscw", "chi", "ubicomp-imwut", "uist", "tochi", "ijhcs"],
    "interdisciplinary-emerging": ["www", "rtss", "jacm", "proceedings-of-the-ieee", "scis", "bioinformatics"]
  };

  test("loads a dedicated constraint profile for every supported CCF-A venue", async () => {
    const venues = await registry.catalog();
    expect(venues).toHaveLength(95);
    expect(venues.filter((venue) => venue.template)).toHaveLength(87);
    expect(venues.filter((venue) => venue.template?.trust === "official").map((venue) => venue.value).sort()).toEqual(["acl", "cvpr", "iclr"]);
    expect(new Set(venues.map((venue) => `${venue.domain}/${venue.value}`)).size).toBe(95);
    expect(venues.every((venue) => /^https:\/\//.test(venue.sourceUrl) && venue.verifiedAt !== "unverified")).toBe(true);
    for (const domain of WRITING_PROFILES) expect(venues.filter((venue) => venue.domain === domain.value).map((venue) => venue.value).sort()).toEqual(official2026[domain.value]!.sort());
    expect(new Set(venues.map((venue) => venue.domain))).toEqual(new Set(WRITING_PROFILES.map((domain) => domain.value)));
    for (const venue of venues) {
      const loaded = await registry.load(paperSkillForProfile(venue.domain), { domain: venue.domain, venueId: venue.value, stage: "submission", ...(venue.tracks?.[0] ? { track: venue.tracks[0].value } : {}) });
      expect(loaded.venueInstructions).toContain(`id: ${venue.value}`);
      expect(loaded.venueInstructions).toContain("## Hard constraints");
      expect(loaded.venueInstructions).toContain("## Writing and review priorities");
      expect(loaded.venueInstructions).toContain("## Planning checklist");
      expect(loaded.instructions).toContain("## SHOULD DO");
      expect(loaded.instructions).toContain("## SHOULDN'T DO");
      expect(loaded.venueInstructions).toContain("# Target conference or journal specialization");
      expect(loaded.venueInstructions).toContain(`Selected publication target: ${venue.label}`);
    }
  });

  test("does not load a venue from a mismatched writing profile", async () => {
    const loaded = await registry.load(paperSkillForProfile("network-information-security"), { domain: "artificial-intelligence", venueId: "neurips", stage: "submission" });
    expect(loaded.venueInstructions).toContain("# Network and information security");
    expect(loaded.venueInstructions).not.toContain("id: neurips");
  });
});
