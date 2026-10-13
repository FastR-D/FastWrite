export type ReferenceAspect = "structure" | "paragraphs" | "argumentation" | "expression";
export type ReferenceScope =
  | { type: "full" }
  | { type: "sections"; sectionIds: string[] }
  | { type: "pages"; from: number; to: number }
  | { type: "excerpt"; from: number; to: number };

export interface ReferenceSelection {
  referenceId: string;
  parseRevision: number;
  scope: ReferenceScope;
  aspects: ReferenceAspect[];
  instruction?: string;
}

export interface ReferenceLocator { page?: number; path?: string; line?: number; }
export interface ReferenceBlock {
  id: string;
  from: number;
  to: number;
  text: string;
  locator: ReferenceLocator;
}
export interface ReferenceSection {
  id: string;
  title: string;
  level: number;
  from: number;
  to: number;
  locator: ReferenceLocator;
}
export interface ParsedReference {
  text: string;
  blocks: ReferenceBlock[];
  sections: ReferenceSection[];
  warnings: string[];
  pageCount?: number;
}
export interface ReferencePaper {
  id: string;
  projectId: string;
  title: string;
  sourceName: string;
  sourceKind: "pdf" | "tex-zip" | "pdf-zip";
  sourceHash: string;
  status: "parsing" | "needs-input" | "ready" | "failed";
  parseRevision: number;
  parserVersion: string;
  mainDocument?: string;
  candidates?: string[];
  warnings: string[];
  sections: ReferenceSection[];
  characterCount: number;
  pageCount?: number;
  error?: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ReferenceSettings {
  projectId: string;
  revision: number;
  selections: ReferenceSelection[];
}
export interface ReferenceStyleAnalysisInput {
  title: string;
  text: string;
  aspects?: ReferenceAspect[];
}
export interface ReferenceStyleAnalysis { features: string[]; }
export interface StyleReferenceContext {
  digest: string;
  instructions: string;
  references: Array<{
    referenceId: string;
    title: string;
    sourceHash: string;
    parseRevision: number;
    scope: ReferenceScope;
    aspects: ReferenceAspect[];
    instruction: string;
    profileHash: string;
    coverage: { characters: number; chunks: number; sections: string[] };
    features: string[];
    examples: Array<{ text: string; locator: ReferenceLocator }>;
  }>;
}
export interface ReferenceProfileStatus {
  referenceId: string;
  status: "missing" | "queued" | "running" | "completed" | "failed" | "cancelled";
  jobId?: string;
  error?: string;
  progress?: { completed: number; total?: number; message?: string };
}
