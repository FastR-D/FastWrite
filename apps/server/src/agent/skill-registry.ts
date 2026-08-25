import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WRITING_PROFILES, type PaperSkillRef, type PublicationTarget, type PublicationVenueOption, type ResearchDomainId } from "@fastwrite/shared";
import { templateForVenue } from "../templates/latex-template-service";

export interface LoadedSkill {
  instructions: string;
  venueInstructions: string;
}

export class SkillRegistry {
  constructor(private readonly skillsDirectory: string) {}

  async load(skill: PaperSkillRef, target?: PublicationTarget): Promise<LoadedSkill> {
    const directory = join(this.skillsDirectory, skill.id);
    const [baseInstructions, specializationInstructions, instructions, profileInstructions] = await Promise.all([
      readFile(join(this.skillsDirectory, "_shared", "academic-writing.md"), "utf8"),
      readFile(join(this.skillsDirectory, "_shared", "venue-specialization.md"), "utf8"),
      readFile(join(directory, "SKILL.md"), "utf8"),
      readFile(join(directory, "references", "profile.md"), "utf8")
    ]);
    const combinedInstructions = `${baseInstructions}\n\n${instructions}`;
    if (!target) return { instructions: combinedInstructions, venueInstructions: profileInstructions };
    if (target.domain !== skill.id || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(target.venueId)) return { instructions: combinedInstructions, venueInstructions: profileInstructions };
    const venueInstructions = await readFile(join(directory, "references", "venues", `${target.venueId}.md`), "utf8");
    const metadata = parseVenueFrontmatter(venueInstructions, skill.id);
    const targetContext = `Selected publication target: ${metadata?.label ?? target.venueId}\nManuscript stage: ${target.stage}\nTrack: ${target.track ?? "main or regular article"}`;
    return { instructions: combinedInstructions, venueInstructions: `${profileInstructions}\n\n${specializationInstructions}\n\n${targetContext}\n\n${venueInstructions}` };
  }

  async catalog(): Promise<PublicationVenueOption[]> {
    const entries: PublicationVenueOption[] = [];
    for (const domain of WRITING_PROFILES) {
      const directory = join(this.skillsDirectory, domain.value, "references", "venues");
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
      for (const file of files.filter((name) => name.endsWith(".md")).sort()) {
        const parsed = parseVenueFrontmatter(await readFile(join(directory, file), "utf8"), domain.value);
        if (parsed) {
          const template = templateForVenue(parsed.value);
          entries.push({ ...parsed, ...(template ? { template } : {}) });
        }
      }
    }
    return entries;
  }
}

function parseVenueFrontmatter(content: string, expectedDomain: ResearchDomainId): PublicationVenueOption | undefined {
  const block = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (!block) return undefined;
  const fields = Object.fromEntries(block.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(line);
    return match?.[1] ? [[match[1], (match[2] ?? "").replace(/^['"]|['"]$/g, "")]] : [];
  }));
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(fields.id ?? "") || fields.domain !== expectedDomain || fields.ccfRank !== "A" || (fields.kind !== "conference" && fields.kind !== "journal")) return undefined;
  const pageLimit = positiveNumber(fields.pageLimit);
  const totalPageLimit = positiveNumber(fields.totalPageLimit);
  const cameraReadyPageLimit = positiveNumber(fields.cameraReadyPageLimit);
  const cameraReadyTotalPageLimit = positiveNumber(fields.cameraReadyTotalPageLimit);
  const requiredSections = splitList(fields.requiredSections);
  const requiredLatex = splitList(fields.requiredLatex);
  const constraints: NonNullable<PublicationVenueOption["constraints"]> = {
    ...(pageLimit ? { pageLimit } : {}),
    ...(totalPageLimit ? { totalPageLimit } : {}),
    ...(cameraReadyPageLimit ? { cameraReadyPageLimit } : {}),
    ...(cameraReadyTotalPageLimit ? { cameraReadyTotalPageLimit } : {}),
    ...(fields.anonymous === "true" || fields.anonymous === "false" ? { anonymous: fields.anonymous === "true" } : {}),
    ...(requiredSections.length ? { requiredSections } : {}),
    ...(requiredLatex.length ? { requiredLatex } : {})
  };
  return {
    value: fields.id!, label: fields.name || fields.id!, kind: fields.kind,
    domain: expectedDomain, edition: fields.edition || "unverified", verifiedAt: fields.verifiedAt || "unverified", sourceUrl: fields.sourceUrl || "",
    ...(Object.keys(constraints).length ? { constraints } : {})
  };
}

function positiveNumber(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function splitList(value?: string): string[] {
  return value ? value.split("|").map((item) => item.trim()).filter(Boolean) : [];
}
