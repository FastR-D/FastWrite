# FastWrite Design

## Paper Memory

Paper Memory is confirmed, evidence-backed context derived from the manuscript. It helps writing workflows stay consistent, but the manuscript itself remains the source of truth.

## Views

- **Overview** is a concise paper-level summary. Lock it when it accurately describes the paper.
- **Sections** stores one summary per outline section. These summaries help keep local writing aligned with the section's purpose.
- **Facts** stores atomic claims with a category and source excerpt. A fact becomes AI context only after confirmation or a human edit locks it.
- **Memory changes** shows differences proposed by regeneration for locked content. It is for maintaining Paper Memory, not for reviewing the manuscript.

## Lifecycle

Generating Memory proposes an overview, section summaries, and facts from source evidence. Confirming or editing a value locks it. When the manuscript changes, the UI marks affected evidence as stale. Regeneration preserves locked content and presents conflicting replacements as candidates; the user chooses whether to keep the locked value or use the candidate.

## Workflow Context

| Workflow | Paper Memory used |
| --- | --- |
| Cross-file Agent | The complete reviewed Memory: User Instructions, paper overview, section summaries, and confirmed or user-locked facts. This is the only workflow that receives the full memory. |
| Revise | A bounded, reviewed paper overview and the exact selected Section summary. It does not receive User Instructions, unreviewed candidates, other sections, or the fact inventory. The local selection, adjacent manuscript sections, and revision history remain its primary context. For an empty or TODO-only Section, Revise preserves the heading and drafts concrete prose from these sources; a placeholder is permitted only when both sources lack the required evidence. |
| Completion | A bounded, reviewed paper overview and the exact Section at the cursor. It does not receive User Instructions, unreviewed candidates, other sections, or the fact inventory. Nearby editor text is its primary context. It uses concrete local Memory before returning a generic placeholder or an empty suggestion. |
| Draft | None. A new draft starts from its explicit brief and Writing Skill rather than a previous paper's Memory. |
| Review and targeted re-review | None. These workflows inspect the current manuscript and compiled PDF/source snapshot directly. |

## Editing And Persistence

`memory.md` lives at the paper root. User Instructions are authored directly in that file. The Paper Memory dialog exposes every overview, section summary, and fact as an independently editable part. Saving an edited part sends it once through the configured `FASTWRITE_MEMORY_*` Provider to normalize mixed-language writing without changing facts, then locks it as human-authored and immediately rewrites `memory.md`. Generation, hierarchy summarization, and edit polishing therefore use the same Memory-specific `.env` model configuration. Regeneration creates candidates without replacing locked content, and **Apply reviewed memory** accepts the outstanding candidate set in one action. `memory.md` is excluded from Memory extraction, Agent source documents, and Review snapshots so it never becomes manuscript evidence.

## Workspace History And Versioning

`PaperProject.version` and per-file versions are internal monotonic counters. They prevent stale writes, bind compile results to the corresponding saved paper, and freeze consistent Agent and Review inputs. They are not user-authored releases or Git commit numbers, so the UI shows the saved snapshot time instead of exposing these counters.

Text edits are saved directly to the managed workspace and coalesced into a local Git checkpoint after two minutes without another edit. Structural changes create a checkpoint immediately, and the Files toolbar can create one manually. Git stash is not used because it would hide the active workspace state and is not a durable history mechanism. The managed history is local and never pushes automatically; GitHub synchronization requires an explicit future flow for credentials, branch selection, conflicts, and user-approved push behavior.
