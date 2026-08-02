import OpenAI from "openai";
import type { DraftOutlineSection, DraftRequest, MemoryCategory, PaperSkillRef, ReviseTurn, TextSelection } from "@fastwrite/shared";

export interface ReviseAgentInput {
  instruction: string;
  selection: TextSelection;
  workingText: string;
  history: ReviseTurn[];
  sectionTitle?: string;
  contextBefore: string;
  contextAfter: string;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface ReviseAgentOutput {
  replacement: string;
  rationale: string;
}

export interface AgentProvider {
  revise(input: ReviseAgentInput, signal?: AbortSignal): Promise<ReviseAgentOutput>;
  planDraft?(input: DraftAgentInput, signal?: AbortSignal): Promise<{ outline: DraftOutlineSection[] }>;
  generateDraft?(input: DraftAgentInput & { outline: DraftOutlineSection[]; mainDocument: string }, signal?: AbortSignal): Promise<{ files: DraftGeneratedFile[] }>;
  review?(input: ReviewAgentInput, signal?: AbortSignal): Promise<ReviewAgentOutput>;
  extractMemory?(input: MemoryAgentInput, signal?: AbortSignal): Promise<MemoryAgentOutput>;
  planAgentTask?(input: AgentTaskInput, signal?: AbortSignal): Promise<AgentTaskPlanOutput>;
  generateAgentTask?(input: AgentTaskInput & AgentTaskPlanOutput, signal?: AbortSignal): Promise<{ files: DraftGeneratedFile[] }>;
  rereviewIssues?(input: AgentTaskInput & { issues: AgentTaskIssue[] }, signal?: AbortSignal): Promise<{ assessments: Array<{ issueId: string; resolved: boolean; assessment: string }>; regressions: string[] }>;
  complete?(input: CompletionAgentInput, signal?: AbortSignal): Promise<{ suggestion: string }>;
}
export interface CompletionAgentInput { intent: "sentence" | "latex" | "formula" | "citation"; path: string; contextBefore: string; contextAfter: string; outline: string[]; bibliography: string; skill: PaperSkillRef; skillInstructions: string; venueInstructions: string }

export interface AgentTaskIssue { id: string; title: string; rationale: string; suggestion: string; evidence: Array<{ path: string; excerpt: string }> }
export interface AgentTaskInput {
  objective: string;
  scope: { type: "file" | "section" | "project"; path?: string };
  issues: AgentTaskIssue[];
  documents: Array<{ path: string; content: string; version: number }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}
export interface AgentTaskPlanOutput { steps: string[]; affectedFiles: string[]; risks: string[]; validation: string[] }

export interface MemoryAgentInput {
  documents: Array<{ path: string; content: string; version: number }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface MemoryAgentOutput {
  items: Array<{ category: MemoryCategory; label: string; content: string; sources: Array<{ path: string; excerpt: string; section: string | null; line: number | null }> }>;
}

export interface ReviewAgentInput {
  documents: Array<{ path: string; content: string }>;
  outline: Array<{ path: string; title: string; line: number }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface ReviewAgentOutput {
  overallAssessment: string;
  recommendation: "strong-accept" | "accept" | "borderline" | "reject" | "strong-reject";
  strengths: string[];
  weaknesses: string[];
  nextSteps: string[];
  issues: Array<{
    category: "novelty" | "soundness" | "technical-depth" | "threat-model" | "evaluation" | "reproducibility" | "related-work" | "clarity" | "ethics";
    severity: "blocking" | "major" | "minor" | "suggestion";
    title: string;
    rationale: string;
    impact: string;
    suggestion: string;
    evidence: Array<{ path: string; section: string | null; line: number | null; excerpt: string; inferred: boolean }>;
  }>;
}

export interface DraftAgentInput {
  request: DraftRequest;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface DraftGeneratedFile {
  path: string;
  content: string;
  rationale: string;
}

export class OpenAIAgentProvider implements AgentProvider {
  private readonly client: OpenAI;
  private readonly configuredModel: string | undefined;
  private readonly customBaseURL: boolean;
  private modelPromise?: Promise<string>;

  constructor(apiKey: string, model?: string, baseURL?: string) {
    this.configuredModel = model?.trim() || undefined;
    this.customBaseURL = Boolean(baseURL?.trim());
    this.client = new OpenAI({ apiKey, ...(baseURL?.trim() ? { baseURL: baseURL.trim().replace(/\/$/, "") } : {}) });
  }

  async revise(input: ReviseAgentInput, signal?: AbortSignal): Promise<ReviseAgentOutput> {
    return this.structured<ReviseAgentOutput>(
      `${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`,
      {
        task: "Continue revising only the selected span. Return a complete replacement for that span and keep the surrounding text unchanged.",
        instruction: input.instruction,
        venue: input.skill.venue,
        section: input.sectionTitle ?? "unknown",
        contextBefore: input.contextBefore,
        originalSelectedText: input.selection.text,
        currentCandidate: input.workingText,
        conversation: input.history,
        contextAfter: input.contextAfter
      },
      "fastwrite_revise",
      {
        type: "object",
        additionalProperties: false,
        properties: { replacement: { type: "string" }, rationale: { type: "string" } },
        required: ["replacement", "rationale"]
      },
      signal
    );
  }

  async planDraft(input: DraftAgentInput, signal?: AbortSignal): Promise<{ outline: DraftOutlineSection[] }> {
    return this.structured(
      `${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`,
      { task: "Plan a compact, evidence-honest security paper outline. Do not draft prose yet. Return at least five unique section files under sections/. The titles must include the exact words Abstract, Introduction, Method or Design, Evaluation, and Conclusion. Never use main.tex as a section path.", ...input.request },
      "fastwrite_draft_outline",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          outline: {
            type: "array",
            minItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string", description: "A unique sections/*.tex path; never main.tex" }, title: { type: "string", description: "Use conventional titles including Abstract, Introduction, Method or Design, Evaluation, and Conclusion across the outline" }, purpose: { type: "string" } },
              required: ["path", "title", "purpose"]
            }
          }
        },
        required: ["outline"]
      },
      signal
    );
  }

  async generateDraft(input: DraftAgentInput & { outline: DraftOutlineSection[]; mainDocument: string }, signal?: AbortSignal): Promise<{ files: DraftGeneratedFile[] }> {
    return this.structured(
      `${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`,
      { task: "Generate a minimal compilable LaTeX security-paper draft. Use explicit TODO markers for missing evidence and never invent citations or results.", ...input.request, outline: input.outline, mainDocument: input.mainDocument },
      "fastwrite_draft_files",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          files: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" }, content: { type: "string" }, rationale: { type: "string" } },
              required: ["path", "content", "rationale"]
            }
          }
        },
        required: ["files"]
      },
      signal
    );
  }

  async review(input: ReviewAgentInput, signal?: AbortSignal): Promise<ReviewAgentOutput> {
    const issueSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        category: { type: "string", enum: ["novelty", "soundness", "technical-depth", "threat-model", "evaluation", "reproducibility", "related-work", "clarity", "ethics"] },
        severity: { type: "string", enum: ["blocking", "major", "minor", "suggestion"] },
        title: { type: "string" }, rationale: { type: "string" }, impact: { type: "string" }, suggestion: { type: "string" },
        evidence: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, section: { type: ["string", "null"] }, line: { type: ["integer", "null"] }, excerpt: { type: "string" }, inferred: { type: "boolean" } }, required: ["path", "section", "line", "excerpt", "inferred"] } }
      },
      required: ["category", "severity", "title", "rationale", "impact", "suggestion", "evidence"]
    };
    return this.structured(
      `${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`,
      { task: "Review this security paper evidence-first. Every issue must cite supplied source evidence or be marked inferred. Do not propose file edits.", outline: input.outline, documents: input.documents },
      "fastwrite_security_review",
      {
        type: "object", additionalProperties: false,
        properties: {
          overallAssessment: { type: "string" },
          recommendation: { type: "string", enum: ["strong-accept", "accept", "borderline", "reject", "strong-reject"] },
          strengths: { type: "array", items: { type: "string" } }, weaknesses: { type: "array", items: { type: "string" } }, nextSteps: { type: "array", items: { type: "string" } },
          issues: { type: "array", items: issueSchema }
        },
        required: ["overallAssessment", "recommendation", "strengths", "weaknesses", "nextSteps", "issues"]
      },
      signal
    );
  }

  async extractMemory(input: MemoryAgentInput, signal?: AbortSignal): Promise<MemoryAgentOutput> {
    return this.structured(
      `${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`,
      { task: "Extract only explicit, reusable paper facts into a proposed Paper Memory. Cite exact supplied source excerpts. Do not infer missing facts.", documents: input.documents },
      "fastwrite_paper_memory",
      {
        type: "object", additionalProperties: false,
        properties: { items: { type: "array", items: { type: "object", additionalProperties: false, properties: {
          category: { type: "string", enum: ["research-question", "contribution", "system-model", "threat-model", "term", "experiment", "limitation", "open-question"] },
          label: { type: "string" }, content: { type: "string" },
          sources: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, excerpt: { type: "string" }, section: { type: ["string", "null"] }, line: { type: ["integer", "null"] } }, required: ["path", "excerpt", "section", "line"] } }
        }, required: ["category", "label", "content", "sources"] } } },
        required: ["items"]
      },
      signal
    );
  }

  async planAgentTask(input: AgentTaskInput, signal?: AbortSignal): Promise<AgentTaskPlanOutput> {
    return this.structured(`${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`, { task: "Plan a scoped paper revision. Do not write files yet.", objective: input.objective, scope: input.scope, issues: input.issues, availableFiles: input.documents.map((document) => document.path) }, "fastwrite_agent_plan", {
      type: "object", additionalProperties: false, properties: {
        steps: { type: "array", minItems: 1, items: { type: "string" } }, affectedFiles: { type: "array", minItems: 1, items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, validation: { type: "array", minItems: 1, items: { type: "string" } }
      }, required: ["steps", "affectedFiles", "risks", "validation"]
    }, signal);
  }

  async generateAgentTask(input: AgentTaskInput & AgentTaskPlanOutput, signal?: AbortSignal): Promise<{ files: DraftGeneratedFile[] }> {
    return this.structured(`${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`, { task: "Execute the approved revision plan. Return complete contents only for files that must change. Preserve unsupported claims and LaTeX syntax.", objective: input.objective, scope: input.scope, issues: input.issues, plan: { steps: input.steps, affectedFiles: input.affectedFiles, risks: input.risks, validation: input.validation }, documents: input.documents }, "fastwrite_agent_files", {
      type: "object", additionalProperties: false, properties: { files: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" }, rationale: { type: "string" } }, required: ["path", "content", "rationale"] } } }, required: ["files"]
    }, signal);
  }

  async rereviewIssues(input: AgentTaskInput & { issues: AgentTaskIssue[] }, signal?: AbortSignal): Promise<{ assessments: Array<{ issueId: string; resolved: boolean; assessment: string }>; regressions: string[] }> {
    return this.structured(`${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`, { task: "Targeted re-review: decide only whether the supplied issues are resolved in the current documents and identify obvious regressions.", issues: input.issues, documents: input.documents }, "fastwrite_issue_rereview", {
      type: "object", additionalProperties: false, properties: {
        assessments: { type: "array", items: { type: "object", additionalProperties: false, properties: { issueId: { type: "string" }, resolved: { type: "boolean" }, assessment: { type: "string" } }, required: ["issueId", "resolved", "assessment"] } },
        regressions: { type: "array", items: { type: "string" } }
      }, required: ["assessments", "regressions"]
    }, signal);
  }

  async complete(input: CompletionAgentInput, signal?: AbortSignal): Promise<{ suggestion: string }> {
    return this.structured(`${input.skillInstructions}\n\nWriting profile guidance:\n${input.venueInstructions}`, { task: `Continue the current file at the cursor using the inferred ${input.intent} intent. For TeX prose, write only the natural next sentence; for .bib, complete a BibTeX entry; inside math or an unfinished LaTeX command, complete only that syntax. Return an empty suggestion when evidence is insufficient. Never invent citations, results, or claims.`, path: input.path, contextBefore: input.contextBefore, contextAfter: input.contextAfter, outline: input.outline, bibliography: input.bibliography }, "fastwrite_completion", { type: "object", additionalProperties: false, properties: { suggestion: { type: "string" } }, required: ["suggestion"] }, signal);
  }

  private async structured<T>(instructions: string, input: unknown, name: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.client.responses.create({
      model: await this.resolveModel(),
      store: false,
      instructions,
      input: JSON.stringify(input),
      text: { verbosity: "low", format: { type: "json_schema", name, strict: true, schema } }
    }, signal ? { signal } : undefined);
    return JSON.parse(response.output_text) as T;
  }

  private resolveModel(): Promise<string> {
    if (this.configuredModel) return Promise.resolve(this.configuredModel);
    if (!this.customBaseURL) return Promise.resolve("gpt-5.6");
    this.modelPromise ??= this.client.models.list().then((page) => {
      const available = page.data.map((model) => model.id);
      const selected = ["gpt-5.6", "deepseek-v4-flash"].find((model) => available.includes(model)) ?? available[0];
      if (!selected) throw new Error("The configured OpenAI-compatible endpoint returned no models");
      return selected;
    });
    return this.modelPromise;
  }
}
