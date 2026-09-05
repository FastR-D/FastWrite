import type { AgentWireApi, ComplianceFinding, DraftOutlineSection, DraftRequest, MemoryCategory, PaperSkillRef, ReviseTurn, TextSelection, EvidenceDependency } from "@fastwrite/shared";

export interface ReviseAgentInput {
  instruction: string;
  selection: TextSelection;
  workingText: string;
  history: ReviseTurn[];
  sectionTitle?: string;
  selectionIsSectionScaffold: boolean;
  selectionKind: "sentence" | "paragraph" | "section";
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
