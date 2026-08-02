export interface ExpectedReviewIssue {
  key: string;
  category: string;
  titleTerms: string[];
  evidence: Array<{ path: string; excerptFragment: string; inferred: boolean }>;
}

export interface EvaluatedReviewIssue {
  category: string;
  title: string;
  rationale: string;
  evidence: Array<{ path: string; excerpt: string; inferred: boolean }>;
}

export interface ReviewEvaluationMetrics {
  issueRecall: number;
  evidenceAccuracy: number;
  inferenceMarkRate: number;
  duplicateRate: number;
}

export function evaluateReview(expected: ExpectedReviewIssue[], actual: EvaluatedReviewIssue[]): ReviewEvaluationMetrics {
  const matches = expected.map((target) => actual.find((issue) => {
    const text = `${issue.title} ${issue.rationale}`.toLowerCase();
    return issue.category === target.category && target.titleTerms.every((term) => text.includes(term.toLowerCase()));
  }));
  const expectedEvidence = expected.flatMap((target, index) => target.evidence.map((evidence) => ({ evidence, actual: matches[index] })));
  const evidenceHits = expectedEvidence.filter(({ evidence, actual: issue }) => issue?.evidence.some((actual) => actual.path === evidence.path && actual.excerpt.includes(evidence.excerptFragment))).length;
  const inferred = expectedEvidence.filter(({ evidence }) => evidence.inferred);
  const inferredHits = inferred.filter(({ evidence, actual: issue }) => issue?.evidence.some((actual) => actual.path === evidence.path && actual.inferred === evidence.inferred)).length;
  const normalizedTitles = actual.map((issue) => issue.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  const duplicateCount = normalizedTitles.length - new Set(normalizedTitles).size;
  return {
    issueRecall: ratio(matches.filter(Boolean).length, expected.length),
    evidenceAccuracy: ratio(evidenceHits, expectedEvidence.length),
    inferenceMarkRate: ratio(inferredHits, inferred.length),
    duplicateRate: ratio(duplicateCount, actual.length)
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 1;
}
