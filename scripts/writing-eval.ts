import { writingGuard, writingGuardMany } from "../apps/server/src/writing/writing-guard";

type Fixture = { name: string; content: string; expected: number; approved?: Set<string> };
const fixtures: Fixture[] = [
  { name: "clean", content: "We improve accuracy by 4%. \\label{fig:main} See \\ref{fig:main}.", expected: 0 },
  { name: "missing-reference", content: "See \\ref{fig:missing}.", expected: 1 },
  { name: "template", content: "TODO: add results", expected: 1 },
  { name: "invalid-percentage", content: "Accuracy improved by 140%.", expected: 1 }
  , { name: "bad-arithmetic", content: "from 10% to 20%, relative improvement of 50%.", expected: 1 }
  , { name: "missing-citation", content: "Prior work shows this \\cite{missing}.", expected: 1, approved: new Set() }
  , { name: "missing-label", content: "See \\ref{fig:missing}.", expected: 1 }
  , { name: "acronym-drift", content: "We use NLP (natural language processing). Later NLP (neural language pipeline) is applied.", expected: 1 }
  , { name: "strong-scope", content: "Our comprehensive method is state-of-the-art and always best.", expected: 1 }
  , { name: "unit-confusion", content: "Relative improvement is 10%, a gain of 2 percentage points.", expected: 1 }
  , { name: "direction-conflict", content: "Accuracy is higher-is-better, while the metric is lower-is-better.", expected: 1 }
];
const crossFile = [
  { path: "a.bib", content: "@article{dup, title={A}}" },
  { path: "b.bib", content: "@article{dup, title={B}}" }
];
let failed = 0;
let passed = 0;
for (const fixture of fixtures) {
  const document = { path: `${fixture.name}.tex`, content: fixture.content, ...(fixture.approved ? { approvedCitationKeys: fixture.approved } : {}) };
  const actual = (fixture.name === "bad-arithmetic" ? writingGuardMany([document]) : writingGuard(document)).length;
  const ok = fixture.name === "clean" ? actual === fixture.expected : actual >= fixture.expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${fixture.name}: ${actual} finding(s)`);
  if (!ok) failed++;
  else passed++;
}
const duplicate = writingGuardMany(crossFile).length;
console.log(`${duplicate ? "PASS" : "FAIL"} duplicate-bib-key: ${duplicate} finding(s)`);
if (!duplicate) failed++;
else passed++;
console.log(JSON.stringify({ total: fixtures.length + 1, passed, failed, cleanFalsePositives: fixtures[0] && writingGuard({ path: "clean.tex", content: fixtures[0].content }).filter(f => f.status === "blocking").length }));
if (failed) process.exit(1);
