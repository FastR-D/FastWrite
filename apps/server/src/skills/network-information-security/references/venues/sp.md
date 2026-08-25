---
id: sp
name: IEEE Symposium on Security and Privacy (S&P)
kind: conference
edition: "2026"
domain: network-information-security
ccfRank: A
pageLimit: 13
totalPageLimit: 18
anonymous: true
requiredSections: Ethics considerations
requiredLatex: IEEEtran|compsoc
verifiedAt: "2026-08-25"
sourceUrl: https://www.ieee-security.org/TC/SP2026/cfpapers.html
---

# IEEE S&P 2026

This file records the S&P 2026 research-paper and SoK rules verified on the date in the frontmatter. The 2026 call is edition-specific; recheck the official CFP before applying it to a later cycle or edition.

## Hard constraints

- Submit a PDF on US letter paper using the IEEE Computer Society `compsoc` conference template. LaTeX must use `\documentclass[conference,compsoc]{IEEEtran}` with IEEEtran 1.8b; do not modify margins, font, or line spacing.
- Limit the submission to **13 pages of text plus up to 5 pages of references and appendices**, for **18 pages total**. Mark all content after page 13 as appendix. Reviewers need not read appendices.
- Use anonymous review: author names, affiliations, acknowledgements, and identifying self-references must not appear. Do not include full CVE identifiers in the submission because they may deanonymize it.
- Include a separate, clearly marked `Ethics considerations` section at the end of every paper. Write `None` if there are no ethics considerations. It may be before or after references and does not count against the main-body page limit.
- For human-subject, sensitive-data, or potentially harmful research, disclose applicable institutional review/waiver status and concrete harm-mitigation steps. For original vulnerabilities, disclose them where possible or document the disclosure plan.
- Register the complete abstract, authors (including ORCIDs), and conflicts by the applicable abstract-registration deadline. The 2026 call does not allow authorship-list changes after that deadline.
- Before submission, real-time verify the active cycle's deadlines, author/COI rules, page-limit interpretation, and any template revision.

## Writing and review priorities

- Present a novel contribution in security or privacy, with theory explicitly connected to practical relevance when the paper is theoretical.
- Make design, implementation, analysis, verification, and empirical evidence proportionate to the claim; distinguish SoK contributions from ordinary surveys.
- If submitting an SoK, prefix the title with `SoK:` and provide a new viewpoint, compelling evidence that challenges/supports established beliefs, or a convincing taxonomy. A summary-only survey is out of scope.
- Write the ethics section as a concrete account of research decisions, affected people, data handling, disclosure, and remaining risks—not generic boilerplate.
- Ensure the submitted version is publication-ready: S&P 2026 has no conditional accept and reviewers decide from the material available at submission and rebuttal.

## Planning checklist

- [ ] Allocate the 13-page main body to problem, threat model, contribution, evidence, limitations, and conclusion; reserve at most five total pages for references/appendix.
- [ ] Verify the `compsoc` document class and US-letter PDF output; remove packages that override IEEE formatting.
- [ ] Add an `Ethics considerations` section even when the appropriate content is `None`.
- [ ] Review disclosure and anonymity together, especially CVEs, vulnerability coordination, PII, IRB/waiver details, funding, and identifying links.
- [ ] For an SoK, verify the title prefix and that the manuscript contributes insight beyond a survey.
- [ ] Recheck the active official submission cycle for registration, COI, and camera-ready disclosure requirements.
