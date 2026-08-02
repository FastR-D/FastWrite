import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaperSkillRef } from "@fastwrite/shared";

export interface LoadedSkill {
  instructions: string;
  venueInstructions: string;
}

export class SkillRegistry {
  constructor(private readonly skillsDirectory: string) {}

  async load(skill: PaperSkillRef): Promise<LoadedSkill> {
    const directory = join(this.skillsDirectory, skill.id);
    const [instructions, venueInstructions] = await Promise.all([
      readFile(join(directory, "SKILL.md"), "utf8"),
      readFile(join(directory, "references", "profile.md"), "utf8")
    ]);
    return { instructions, venueInstructions };
  }
}
