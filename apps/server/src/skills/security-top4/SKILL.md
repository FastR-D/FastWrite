---
name: security-top4
description: Plan, draft, revise, and review computer-security research papers for the shared IEEE S&P, USENIX Security, ACM CCS, and NDSS writing style. Use for paper structure, academic prose, threat models, contribution claims, evaluation arguments, and reviewer-style critique throughout Agent, Revise, and Review workflows.
---

# Security Top-4

Treat the paper as an evidence-backed security argument. Preserve technical meaning, LaTeX commands, citations, labels, math, and author-defined terminology unless the task explicitly requests a structural change.

## Read the shared profile

Read [references/profile.md](references/profile.md) before acting. Do not infer or apply conference-specific stylistic differences: IEEE S&P, USENIX Security, ACM CCS, and NDSS use this one shared Security Top-4 profile.

## Plan and draft

1. State the security problem, affected assets, adversary, and practical impact early.
2. Make each contribution concrete, distinguishable, and supported by later evidence.
3. Keep threat model, assumptions, mechanism, security analysis, evaluation, limitations, and ethics mutually consistent.
4. Prefer an outline whose section responsibilities form a single argument over a generic template.
5. Mark unknown evidence and citations as explicit placeholders; never invent results, citations, deployments, or claims.

## Revise selected text

1. Infer the paragraph's role from its section and neighboring context.
2. Follow the requested shortcut or custom instruction while retaining factual scope and author voice.
3. Make the smallest revision that materially improves clarity, logic, precision, or concision.
4. Keep commands and citation keys syntactically intact. Do not add a citation key that is absent from supplied material.
5. Return replacement text only for the selected span plus a brief rationale. Do not wrap output in Markdown fences.

## Review

1. Review claims against evidence in the supplied manuscript, not against imagined experiments.
2. Prioritize soundness, novelty, threat-model completeness, reproducibility, evaluation validity, ethics, and clarity.
3. Separate blocking weaknesses from actionable improvements and minor presentation issues.
4. Point to concrete sections or passages and propose verifiable next actions.

## Quality gate

- Reject unsupported strengthening such as changing “may” to “demonstrates.”
- Keep terminology consistent across the manuscript.
- Prefer direct, precise prose; remove throat-clearing and inflated novelty language.
- Surface uncertainty instead of silently resolving it.
- Keep all changes within the user's requested scope.
