import { writingGuard, writingGuardMany } from "../apps/server/src/writing/writing-guard";

type Fixture = { name: string; content: string; expected: "clean" | "finding" | "blocking"; approved?: Set<string> };
const fixtures: Fixture[] = [
  { name: "clean", content: "We improve accuracy by 4%. \\label{fig:main} See \\ref{fig:main}.", expected: "clean" },
  { name: "missing-reference", content: "See \\ref{fig:missing}.", expected: "blocking" },
  { name: "template", content: "TODO: add results", expected: "finding" },
  { name: "invalid-percentage", content: "Accuracy improved by 140%.", expected: "blocking" },
  { name: "bad-arithmetic", content: "from 10% to 20%, relative improvement of 50%.", expected: "blocking" },
  { name: "missing-citation", content: "Prior work shows this \\cite{missing}.", expected: "blocking", approved: new Set() },
  { name: "acronym-drift", content: "We use NLP (natural language processing). Later NLP (neural language pipeline) is applied.", expected: "finding" },
  { name: "strong-scope", content: "Our comprehensive method is state-of-the-art and always best.", expected: "finding" },
  { name: "unit-confusion", content: "Relative improvement is 10%, a gain of 2 percentage points.", expected: "finding" },
  { name: "direction-conflict", content: "Accuracy is higher-is-better, while the metric is lower-is-better.", expected: "finding" }
];
const crossFile = [
  { path: "a.bib", content: "@article{dup, title={A}}" },
  { path: "b.bib", content: "@article{dup, title={B}}" }
];
const results = fixtures.map((fixture) => {
  const document = { path: `${fixture.name}.tex`, content: fixture.content, ...(fixture.approved ? { approvedCitationKeys: fixture.approved } : {}) };
  const findings = writingGuardMany([document]);
  const actual = findings.length;
  const kind = actual === 0 ? "clean" : (findings.some((finding) => finding.status === "blocking") ? "blocking" : "finding");
  return { name: fixture.name, expected: fixture.expected, actual: kind, pass: kind === fixture.expected, findings: actual, blocking: findings.filter((finding) => finding.status === "blocking").length };
});
const duplicate = writingGuardMany(crossFile).length;
results.push({ name: "duplicate-bib-key", expected: "blocking", actual: duplicate ? "blocking" : "clean", pass: duplicate > 0, findings: duplicate, blocking: duplicate });
const total = results.length;
const passed = results.filter((item) => item.pass).length;
const expectedDefects = results.filter((item) => item.expected !== "clean").length;
const detectedDefects = results.filter((item) => item.expected !== "clean" && item.actual !== "clean").length;
const blockingExpected = results.filter((item) => item.expected === "blocking").length;
const blockingDetected = results.filter((item) => item.expected === "blocking" && item.blocking > 0).length;
const summary = { generatedAt: new Date().toISOString(), total, passed, failed: total - passed, score: passed / total, cleanFalsePositives: results.filter((item) => item.expected === "clean" && item.actual !== "clean").length, defectRecall: detectedDefects / expectedDefects, blockingRecall: blockingDetected / blockingExpected, results };
for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${result.actual} (${result.findings} finding(s))`);
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exit(1);
