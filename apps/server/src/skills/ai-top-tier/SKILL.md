---
name: ai-top-tier
description: Plan, draft, revise, and review AI and machine-learning research papers using one shared top-tier profile. Use for paper structure, precise academic prose, contribution claims, methods, experiments, ablations, reproducibility, limitations, and reviewer-style critique throughout Agent, Revise, and Review workflows.
---

# AI Top-Tier

Treat the paper as an evidence-backed machine-learning argument. Preserve technical meaning, LaTeX commands, citations, labels, math, notation, and author-defined terminology unless the task explicitly requests a structural change.

## Read the shared profile

Read [references/profile.md](references/profile.md) before acting. Use one common AI top-tier writing profile rather than conference-specific variants.

## Plan and draft

1. State the research problem, motivation, setting, assumptions, and intended contribution early.
2. Separate conceptual novelty, algorithmic contribution, empirical finding, and engineering contribution; support each with later evidence.
3. Keep problem formulation, method, theory, experiments, limitations, and broader impacts mutually consistent.
4. Design experiments around falsifiable questions, meaningful baselines, ablations, uncertainty, and reproducibility.
5. Mark missing evidence and citations as explicit placeholders; never invent results, datasets, citations, or claims.

## Revise selected text

1. Infer the selected passage's role from its section and neighboring context.
2. Follow the requested shortcut or instruction while preserving factual scope, notation, and author voice.
3. Make the smallest revision that materially improves clarity, logic, precision, or concision.
4. Keep commands, math, and citation keys syntactically intact. Do not add a citation key absent from supplied material.
5. Return replacement text only for the selected span plus a brief rationale. Do not wrap output in Markdown fences.

## Review

1. Review claims against supplied manuscript evidence, not imagined experiments.
2. Prioritize novelty, correctness, methodological soundness, experimental validity, ablations, reproducibility, clarity, limitations, ethics, and broader impacts.
3. Separate blocking weaknesses from actionable improvements and minor presentation issues.
4. Point to concrete sections or passages and propose verifiable next actions.

## Quality gate

- Reject unsupported causal, generalization, state-of-the-art, or significance claims.
- Keep notation and terminology consistent across the manuscript.
- Prefer direct, precise prose over throat-clearing and inflated novelty language.
- Surface uncertainty and negative evidence instead of silently resolving them.
- Keep all changes within the user's requested scope.
