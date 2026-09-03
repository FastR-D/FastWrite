import OpenAI from "openai";
import type { AgentWireApi, ComplianceFinding, DraftOutlineSection, DraftRequest, MemoryCategory, PaperSkillRef, ReviseTurn, TextSelection, EvidenceDependency } from "@fastwrite/shared";

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
  fileGenerationConcurrency?(): number;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finalText(value: unknown): string {
  const item = record(value);
  if (!item) return typeof value === "string" ? value : "";
  if (typeof item.output_text === "string" && item.output_text) return item.output_text;
  if ((item.type === "output_text" || item.type === "text") && typeof item.text === "string") return item.text;
  if (item.type === "response.output_text.done" && typeof item.text === "string") return item.text;
  for (const key of ["response", "item", "part"]) {
    const nested = finalText(item[key]);
    if (nested) return nested;
  }
  if (Array.isArray(item.output)) {
    const text = item.output.map(finalText).join("");
    if (text) return text;
  }
  if (Array.isArray(item.content)) {
    const text = item.content.map(finalText).join("");
    if (text) return text;
  }
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.choices)) {
    const text = item.choices.map((choice) => {
      const candidate = record(choice);
      return finalText(candidate?.message) || (typeof candidate?.text === "string" ? candidate.text : "");
    }).join("");
    if (text) return text;
  }
  return "";
}

function responseShape(payloads: unknown[], contentType: string, byteLength: number, declaredEvents: string[] = [], parseFailures = 0, sawDone = false): string {
  const objects = payloads.map(record).filter((item): item is Record<string, unknown> => Boolean(item));
  const eventTypes = [...new Set([...declaredEvents, ...objects.map((item) => typeof item.type === "string" ? item.type : undefined).filter((type): type is string => Boolean(type))])];
  const statuses = [...new Set(objects.flatMap((item) => {
    const nested = record(item.response);
    return [item.status, nested?.status].filter((status): status is string => typeof status === "string");
  }))];
  const outputTypes = [...new Set(objects.flatMap((item) => {
    const source = record(item.response) ?? item;
    return Array.isArray(source.output) ? source.output.map((output) => record(output)?.type).filter((type): type is string => typeof type === "string") : [];
  }))];
  return [`content-type=${contentType || "missing"}`, `bytes=${byteLength}`, eventTypes.length ? `events=${eventTypes.join(",")}` : "events=none", `parsed=${payloads.length}`, `parse-failures=${parseFailures}`, `done=${sawDone ? "yes" : "no"}`, statuses.length ? `status=${statuses.join(",")}` : "status=missing", outputTypes.length ? `output=${outputTypes.join(",")}` : "output=none"].join("; ");
}

async function compatibleResponseText(response: Response): Promise<{ content: string; shape: string }> {
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const looksLikeSSE = contentType.toLowerCase().includes("text/event-stream") || /(?:^|\n)\s*(?:event|data):/.test(body);
  const payloads: unknown[] = [];
  const declaredEvents: string[] = [];
  let parseFailures = 0;
  let sawDone = false;
  if (looksLikeSSE) {
    let eventType = "";
    let dataLines: string[] = [];
    const flush = () => {
      const withNewlines = dataLines.join("\n").trim();
      const compact = dataLines.join("").trim();
      if (withNewlines && withNewlines !== "[DONE]") {
        let parsed: unknown;
        let parsedSuccessfully = false;
        for (const candidate of [...new Set([withNewlines, compact])]) {
          try { parsed = JSON.parse(candidate); parsedSuccessfully = true; break; } catch { /* Try the mirror's alternate multi-data framing. */ }
        }
        if (parsedSuccessfully) {
          const item = record(parsed);
          if (item) payloads.push(typeof item.type !== "string" && eventType ? { ...item, type: eventType } : item);
          else if (typeof parsed === "string" && eventType === "response.output_text.delta") payloads.push({ type: eventType, delta: parsed });
          else if (typeof parsed === "string" && eventType === "response.output_text.done") payloads.push({ type: eventType, text: parsed });
          else payloads.push(parsed);
        } else if (eventType === "response.output_text.delta" && !/^[{[]/.test(compact)) {
          payloads.push({ type: eventType, delta: withNewlines });
        } else if (eventType === "response.output_text.done" && !/^[{[]/.test(compact)) {
          payloads.push({ type: eventType, text: withNewlines });
        } else {
          parseFailures += 1;
        }
      }
      eventType = "";
      dataLines = [];
    };
    for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
      if (!line) { flush(); continue; }
      if (line.startsWith("event:")) {
        if (dataLines.length) flush();
        eventType = line.slice(6).trim();
        if (eventType) declaredEvents.push(eventType);
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trimStart();
        if (data.trim() === "[DONE]") { flush(); sawDone = true; }
        else dataLines.push(data);
      }
    }
    flush();
  } else if (body.trim()) {
    try { payloads.push(JSON.parse(body)); } catch { parseFailures += 1; }
  }
  const deltas = payloads.map(record).filter((item): item is Record<string, unknown> => item?.type === "response.output_text.delta" && typeof item.delta === "string").map((item) => item.delta as string).join("");
  const completed = [...payloads].reverse().map(finalText).find(Boolean) ?? "";
  return { content: deltas || completed, shape: responseShape(payloads, contentType, body.length, declaredEvents, parseFailures, sawDone) };
}

export class OpenAIAgentProvider implements AgentProvider {
  private readonly client: OpenAI;
  private readonly configuredModel: string | undefined;
  private readonly customBaseURL: boolean;
  private readonly wireAPI: AgentWireApi;
  private modelPromise?: Promise<string>;

  constructor(apiKey: string, model?: string, baseURL?: string, wireAPI?: AgentWireApi) {
    this.configuredModel = model?.trim() || undefined;
    this.customBaseURL = Boolean(baseURL?.trim());
    this.wireAPI = wireAPI ?? (this.customBaseURL ? "chat" : "responses");
    this.client = new OpenAI({ apiKey, ...(baseURL?.trim() ? { baseURL: baseURL.trim().replace(/\/$/, "") } : {}) });
  }

  fileGenerationConcurrency(): number {
    return this.customBaseURL && this.wireAPI === "responses" ? 1 : 4;
  }

  async revise(input: ReviseAgentInput, signal?: AbortSignal): Promise<ReviseAgentOutput> {
    return this.structured<ReviseAgentOutput>(
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      {
        task: "Revise only the selected span and return its complete replacement. When selectionIsSectionScaffold is true, preserve the LaTeX section heading and draft concrete section prose from Reviewed Local Paper Context and adjacent manuscript context. Prefer supplied terminology, contributions, findings, and limitations over generic bracketed placeholders. Use an explicit plain-text TODO only when neither source contains enough evidence; never put a placeholder inside a LaTeX citation command, and never invent evidence, citations, or results.",
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
    const requiredPaths = [input.mainDocument, ...input.outline.map((section) => section.path)];
    return this.structured(
      `${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`,
      { task: `Generate a minimal compilable LaTeX research-paper draft for the selected publication target. The files array must contain exactly one entry for the main document and every confirmed outline path: ${requiredPaths.join(", ")}. The main document must include the section files. Use explicit TODO markers for missing evidence and never invent citations or results.`, ...input.request, outline: input.outline, mainDocument: input.mainDocument, requiredPaths },
      "fastwrite_draft_files",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          files: {
            type: "array",
            minItems: requiredPaths.length,
            items: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string", description: `Must be one of these required paths, each returned once: ${requiredPaths.join(", ")}` }, content: { type: "string" }, rationale: { type: "string" } },
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
    return this.structured(`${input.skillInstructions}\n\nResearch-domain and publication-target guidance:\n${input.venueInstructions}`, { task: `Execute the approved ${input.intent} paper plan for targetPath. Return exactly one non-empty file whose path is exactly targetPath, containing that file's complete content. Do not return companion files; FastWrite generates each planned file separately. Satisfy the approved venue checks that apply to this file without inventing compliance evidence. When evidence is missing, use a plain-text TODO and never put placeholders such as [EVIDENCE REQUIRED] inside a LaTeX citation command. LaTeX comments are intentionally omitted from Agent context and restored by FastWrite; do not invent or act on hidden comment lines. Preserve unsupported claims and LaTeX syntax.`, intent: input.intent, objective: input.objective, scope: input.scope, issues: input.issues, targetPath: input.targetPath, plan: { steps: input.steps, affectedFiles: input.affectedFiles, risks: input.risks, validation: input.validation, sectionBudget: input.sectionBudget ?? [], venueChecks: input.venueChecks ?? [] }, documents: input.documents }, "fastwrite_agent_files", {
      type: "object", additionalProperties: false, properties: { files: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", additionalProperties: false, properties: { path: { type: "string", const: input.targetPath }, content: { type: "string", minLength: 1 }, rationale: { type: "string" } }, required: ["path", "content", "rationale"] } } }, required: ["files"]
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
    const jsonInstructions = `${instructions}\n\nReturn only one valid JSON object matching the supplied JSON schema. JSON-escape every backslash in string values, especially LaTeX commands.`;
    // Some Responses-compatible gateways validate only input/user messages for the
    // literal word "json" and do not count top-level instructions.
    const jsonInput = `Return the result as JSON.\n\nInput data:\n${JSON.stringify(input)}`;
    if (this.wireAPI === "chat") {
      return JSON.parse(await this.chatStructured(model, jsonInstructions, jsonInput, name, schema, signal)) as T;
    }
    if (this.customBaseURL) {
      // Inspect the raw response because Codex mirrors vary between standard SSE,
      // a completed-event-only stream, and a one-shot JSON body even with stream=true.
      const request = this.client.responses.create({
        model,
        store: false,
        stream: true,
        instructions: `${jsonInstructions}\n\nSchema (${name}):\n${JSON.stringify(schema)}`,
        input: [{ role: "user", content: [{ type: "input_text", text: jsonInput }] }],
        text: { format: { type: "json_object" } }
      }, signal ? { signal } : undefined);
      const { content, shape } = await compatibleResponseText(await request.asResponse());
      if (!content) {
        try {
          return JSON.parse(await this.chatStructured(model, jsonInstructions, jsonInput, name, schema, signal)) as T;
        } catch (error) {
          const status = record(error)?.status;
          const fallback = typeof status === "number" ? `HTTP ${status}` : error instanceof SyntaxError ? "invalid JSON" : "no compatible output";
          throw new Error(`The configured Responses endpoint returned no structured output (${shape}); Chat Completions fallback failed (${fallback})`);
        }
      }
      return JSON.parse(content) as T;
    }
    const response = await this.client.responses.create({
      model,
      store: false,
      instructions: jsonInstructions,
      input: jsonInput,
      text: { verbosity: "low", format: { type: "json_schema", name, strict: true, schema } }
    }, signal ? { signal } : undefined);
    return JSON.parse(response.output_text) as T;
  }

  private async chatStructured(model: string, jsonInstructions: string, jsonInput: string, name: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: `${jsonInstructions}\n\nSchema (${name}):\n${JSON.stringify(schema)}` },
        { role: "user", content: jsonInput }
      ],
      response_format: { type: "json_object" }
    }, signal ? { signal } : undefined);
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("The configured model returned no structured output");
    return content;
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
