import OpenAI from "openai";
import type { ComplianceFinding, DraftOutlineSection, DraftRequest, MemoryCategory, PaperSkillRef, ReviseTurn, TextSelection, EvidenceDependency } from "@fastwrite/shared";

export interface ReviseAgentInput {
  instruction: string;
  selection: TextSelection;
  workingText: string;
  history: ReviseTurn[];
  sectionTitle?: string;
  selectionIsSectionScaffold: boolean;
  contextBefore: string;
  contextAfter: string;
  /** Compact overview and active-section context, not the full Paper Memory. */
  paperContext?: string;
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
  reviewPass?(input: ReviewAgentInput & { pass: "mechanical" | "evidence" | "domain" | "venue" }, signal?: AbortSignal): Promise<ReviewAgentOutput>;
  extractMemory?(input: MemoryAgentInput, signal?: AbortSignal): Promise<MemoryAgentOutput>;
  summarizeMemory?(input: MemoryHierarchyInput, signal?: AbortSignal): Promise<MemoryHierarchyOutput>;
  polishMemory?(input: MemoryPolishInput, signal?: AbortSignal): Promise<{ content: string }>;
  planAgentTask?(input: AgentTaskInput, signal?: AbortSignal): Promise<AgentTaskPlanOutput>;
  generateAgentTask?(input: AgentTaskExecutionInput, signal?: AbortSignal): Promise<{ files: DraftGeneratedFile[] }>;
  rereviewIssues?(input: AgentTaskInput & { issues: AgentTaskIssue[] }, signal?: AbortSignal): Promise<{ assessments: Array<{ issueId: string; resolved: boolean; assessment: string }>; regressions: string[] }>;
  complete?(input: CompletionAgentInput, signal?: AbortSignal): Promise<{ suggestion: string }>;
}
export interface CompletionAgentInput { intent: "sentence" | "latex" | "formula" | "citation"; path: string; contextBefore: string; contextAfter: string; paperContext?: string; outline: string[]; bibliography: string; skill: PaperSkillRef; skillInstructions: string; venueInstructions: string }

export interface AgentTaskIssue { id: string; title: string; rationale: string; suggestion: string; evidence: Array<{ path: string; excerpt: string }> }
export interface AgentTaskInput {
  objective: string;
  intent: "draft" | "continue" | "revise";
  scope: { type: "file" | "section" | "project"; path?: string };
  issues: AgentTaskIssue[];
  documents: Array<{ path: string; content: string; version: number }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
  complianceFindings?: ComplianceFinding[];
}
export interface AgentTaskPlanOutput {
  steps: string[];
  affectedFiles: string[];
  risks: string[];
  validation: string[];
  sectionBudget?: Array<{ section: string; targetPages?: number; purpose: string }>;
  venueChecks?: Array<{ requirement: string; status: "satisfied" | "missing" | "uncertain" | "not-applicable"; evidencePaths: string[]; action: string }>;
  evidenceDependencies?: EvidenceDependency[];
  missingEvidence?: string[];
}
export interface AgentTaskExecutionInput extends AgentTaskInput, AgentTaskPlanOutput { targetPath: string }

export interface MemoryAgentInput {
  documents: Array<{ path: string; content: string; version: number }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface MemoryAgentOutput {
  items: Array<{ category: MemoryCategory; label: string; content: string; sources: Array<{ path: string; excerpt: string; section: string | null; line: number | null }> }>;
}

export interface MemoryHierarchyInput {
  outline: Array<{ path: string; title: string; line: number }>;
  facts: Array<{ category: MemoryCategory; label: string; content: string; sources: Array<{ path: string; section?: string }> }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface MemoryHierarchyOutput {
  overview: string;
  sections: Array<{ path: string; title: string; content: string }>;
}

export interface MemoryPolishInput {
  kind: "overview" | "section" | "fact";
  title: string;
  content: string;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
}

export interface ReviewAgentInput {
  documents: Array<{ path: string; content: string }>;
  outline: Array<{ path: string; title: string; line: number }>;
  skill: PaperSkillRef;
  skillInstructions: string;
  venueInstructions: string;
  pdfPageText?: string[];
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
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      {
        task: "Revise only the selected span and return its complete replacement. When selectionIsSectionScaffold is true, preserve the LaTeX section heading and draft concrete section prose from Reviewed Local Paper Context and adjacent manuscript context. Prefer supplied terminology, contributions, findings, and limitations over generic bracketed placeholders. Use an explicit placeholder only when neither source contains enough evidence; never invent evidence, citations, or results.",
        instruction: input.instruction,
        venue: input.skill.venue,
        section: input.sectionTitle ?? "unknown",
        selectionIsSectionScaffold: input.selectionIsSectionScaffold,
        contextBefore: input.contextBefore,
        originalSelectedText: input.selection.text,
        currentCandidate: input.workingText,
        conversation: input.history,
        contextAfter: input.contextAfter,
        localPaperContext: input.paperContext ?? ""
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
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      { task: "Plan a compact, evidence-honest research paper outline for the selected research domain and publication target. Do not draft prose yet. Return at least five unique section files under sections/. Include Abstract, Introduction, an appropriate method or design section, Evaluation, and Conclusion unless the venue guidance requires a different article structure. Never use main.tex as a section path.", ...input.request },
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
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      { task: "Generate a minimal compilable LaTeX research-paper draft for the selected publication target. Use explicit TODO markers for missing evidence and never invent citations or results.", ...input.request, outline: input.outline, mainDocument: input.mainDocument },
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
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      { task: "Review this research paper evidence-first against the selected research domain and publication-target requirements. Every issue must cite supplied source evidence or be marked inferred. Do not propose file edits.", outline: input.outline, documents: input.documents },
      "fastwrite_paper_review",
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

  async reviewPass(input: ReviewAgentInput & { pass: "mechanical" | "evidence" | "domain" | "venue" }, signal?: AbortSignal): Promise<ReviewAgentOutput> {
    return this.review({ ...input, venueInstructions: `${input.venueInstructions}\n\nReview pass: ${input.pass}. Restrict findings to this pass and do not duplicate unrelated concerns.` }, signal);
  }

  async extractMemory(input: MemoryAgentInput, signal?: AbortSignal): Promise<MemoryAgentOutput> {
    return this.structured(
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
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

  async summarizeMemory(input: MemoryHierarchyInput, signal?: AbortSignal): Promise<MemoryHierarchyOutput> {
    return this.structured(
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      {
        task: "Create a concise hierarchical Paper Memory from the supplied evidence-backed facts. Do not invent facts. Write one paper overview and one compact summary for each supplied outline section. Preserve uncertainty and TODOs.",
        outline: input.outline,
        facts: input.facts
      },
      "fastwrite_paper_memory_hierarchy",
      {
        type: "object", additionalProperties: false,
        properties: {
          overview: { type: "string" },
          sections: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: { path: { type: "string" }, title: { type: "string" }, content: { type: "string" } },
              required: ["path", "title", "content"]
            }
          }
        },
        required: ["overview", "sections"]
      },
      signal
    );
  }

  async polishMemory(input: MemoryPolishInput, signal?: AbortSignal): Promise<{ content: string }> {
    return this.structured(
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      {
        task: "Polish this user-edited Paper Memory entry into concise, consistent academic English. The input may mix Chinese and English. Preserve every technical term, number, citation, uncertainty marker, TODO, and evidence boundary. Do not add, remove, infer, or strengthen facts.",
        kind: input.kind,
        title: input.title,
        content: input.content
      },
      "fastwrite_paper_memory_polish",
      {
        type: "object",
        additionalProperties: false,
        properties: { content: { type: "string" } },
        required: ["content"]
      },
      signal
    );
  }

  async planAgentTask(input: AgentTaskInput, signal?: AbortSignal): Promise<AgentTaskPlanOutput> {
    return this.structured(`${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`, { task: `Plan a ${input.intent} paper task. Do not write files yet. Make the plan satisfy the selected publication target and address deterministic compliance findings. Report a section page budget when the target has a page limit, and audit each relevant venue requirement without claiming source-only evidence proves rendered-PDF compliance. For draft, continue, or structural organization tasks such as splitting main.tex into chapter/section files, you may propose new workspace-relative .tex or .bib files.`, intent: input.intent, objective: input.objective, scope: input.scope, issues: input.issues, complianceFindings: input.complianceFindings ?? [], availableFiles: input.documents.map((document) => document.path), documents: input.documents }, "fastwrite_agent_plan", {
      type: "object", additionalProperties: false, properties: {
        steps: { type: "array", minItems: 1, items: { type: "string" } }, affectedFiles: { type: "array", minItems: 1, items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, validation: { type: "array", minItems: 1, items: { type: "string" } },
        sectionBudget: { type: "array", items: { type: "object", additionalProperties: false, properties: { section: { type: "string" }, targetPages: { type: "number" }, purpose: { type: "string" } }, required: ["section", "purpose"] } },
        venueChecks: { type: "array", items: { type: "object", additionalProperties: false, properties: { requirement: { type: "string" }, status: { type: "string", enum: ["satisfied", "missing", "uncertain", "not-applicable"] }, evidencePaths: { type: "array", items: { type: "string" } }, action: { type: "string" } }, required: ["requirement", "status", "evidencePaths", "action"] } }
      }, required: ["steps", "affectedFiles", "risks", "validation", "sectionBudget", "venueChecks"]
    }, signal);
  }

  async generateAgentTask(input: AgentTaskExecutionInput, signal?: AbortSignal): Promise<{ files: DraftGeneratedFile[] }> {
    return this.structured(`${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`, { task: `Execute the approved ${input.intent} paper plan for targetPath. Return targetPath's complete content. Satisfy the approved venue checks that apply to this file without inventing compliance evidence. If targetPath is tightly coupled to companion files already listed in affectedFiles (for example while splitting main.tex into chapter files), you may include those additional planned files too. Do not return paths outside affectedFiles. LaTeX comments are intentionally omitted from Agent context and restored by FastWrite; do not invent or act on hidden comment lines. Preserve unsupported claims and LaTeX syntax.`, intent: input.intent, objective: input.objective, scope: input.scope, issues: input.issues, targetPath: input.targetPath, plan: { steps: input.steps, affectedFiles: input.affectedFiles, risks: input.risks, validation: input.validation, sectionBudget: input.sectionBudget ?? [], venueChecks: input.venueChecks ?? [] }, documents: input.documents }, "fastwrite_agent_files", {
      type: "object", additionalProperties: false, properties: { files: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" }, rationale: { type: "string" } }, required: ["path", "content", "rationale"] } } }, required: ["files"]
    }, signal);
  }

  async rereviewIssues(input: AgentTaskInput & { issues: AgentTaskIssue[] }, signal?: AbortSignal): Promise<{ assessments: Array<{ issueId: string; resolved: boolean; assessment: string }>; regressions: string[] }> {
    return this.structured(`${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`, { task: "Targeted re-review: decide only whether the supplied issues are resolved in the current documents and identify obvious regressions.", issues: input.issues, documents: input.documents }, "fastwrite_issue_rereview", {
      type: "object", additionalProperties: false, properties: {
        assessments: { type: "array", items: { type: "object", additionalProperties: false, properties: { issueId: { type: "string" }, resolved: { type: "boolean" }, assessment: { type: "string" } }, required: ["issueId", "resolved", "assessment"] } },
        regressions: { type: "array", items: { type: "string" } }
      }, required: ["assessments", "regressions"]
    }, signal);
  }

  async complete(input: CompletionAgentInput, signal?: AbortSignal): Promise<{ suggestion: string }> {
    return this.structured(`${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`, { task: `Continue the current file at the cursor using the inferred ${input.intent} intent. For TeX prose, write only the natural next sentence; for .bib, complete a BibTeX entry; inside math or an unfinished LaTeX command, complete only that syntax. Use Local Paper Context when it supplies concrete information instead of emitting generic placeholders. Return an empty suggestion only when both nearby text and Local Paper Context lack sufficient evidence. Never invent citations, results, or claims.`, path: input.path, contextBefore: input.contextBefore, contextAfter: input.contextAfter, localPaperContext: input.paperContext ?? "", outline: input.outline, bibliography: input.bibliography }, "fastwrite_completion", { type: "object", additionalProperties: false, properties: { suggestion: { type: "string" } }, required: ["suggestion"] }, signal);
  }

  private async structured<T>(instructions: string, input: unknown, name: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const model = await this.resolveModel();
    if (this.customBaseURL) {
      const response = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: `${instructions}\n\nReturn only one valid JSON object matching the following schema. JSON-escape every backslash in string values, especially LaTeX commands.\n\nSchema (${name}):\n${JSON.stringify(schema)}`
          },
          { role: "user", content: JSON.stringify(input) }
        ],
        response_format: { type: "json_object" }
      }, signal ? { signal } : undefined);
      const content = response.choices[0]?.message.content;
      if (!content) throw new Error("The configured model returned no structured output");
      return JSON.parse(content) as T;
    }
    const response = await this.client.responses.create({
      model,
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
