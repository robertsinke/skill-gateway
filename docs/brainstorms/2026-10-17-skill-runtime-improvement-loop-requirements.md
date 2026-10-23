# Requirements: Skill Runtime Improvement Loop

Date: 2026-10-17
Status: Scope confirmed; requirements captured for planning

## Summary

Close the improvement loop around the existing skill runtime: discovery, retrieval, selection, loading, and composition inside the agent loop. The system should discover improvement opportunities from real usage, test bounded changes, and measure whether subsequent recommendations improve—without requiring the user to diagnose patterns or manually curate every evaluation case.

## Problem Frame

Capturing skill usage is not itself learning. The gateway needs a repeatable connection between observed runtime behavior, an improvement hypothesis, an evaluated change, and evidence from future use. A recommendation that increases skill loading may still waste context or hurt task outcomes.

The user supplies framing and consequential judgment; the system owns evidence analysis, experiment execution, and reporting. The first slice improves use of existing skills, not a broader personalized-memory product.

## Actors

- **A1 — User:** frames priorities and can steer proposed changes without analyzing raw logs.
- **A2 — Runtime agent:** discovers and uses skills during real tasks within a finite context budget.
- **A3 — Improvement process:** analyzes usage evidence, identifies hypotheses, runs comparisons, and reports results and limitations.

## Key Flows

- **F1 — Task execution:** a user turn triggers skill discovery and selection; the agent loads applicable skills and combines compatible guidance. No applicable skill is a valid outcome. Record what was offered and actually loaded without claiming that a read proves useful application.
- **F2 — Evidence to experiment:** the improvement process examines accumulated usage, identifies a supported runtime failure pattern, and proposes a bounded change. Insufficient evidence produces an explicit uncertainty report rather than a fabricated improvement.
- **F3 — Evaluation to next use:** compare a candidate against the current baseline on held-out tasks, expose regressions and costs, and measure future behavior for any activated change. Failed or inconclusive candidates are not represented as improvements.

## Requirements

**Runtime behavior**

- **R1:** Cover discovery, retrieval, selection, loading, and composition of existing library skills. Evaluate these as distinct stages so a failure can be attributed rather than hidden in an aggregate score.
- **R2:** Support abstention and a small task-appropriate set of skills within a finite context budget. More injected or loaded skills is not the objective.
- **R3:** Evaluate composition explicitly: whether selected skills work together, duplicate guidance, or introduce conflicting instructions. Preserve user and repository instruction precedence; do not infer successful composition from multiple load events alone.

**Evidence and improvement**

- **R4:** Reuse existing gate, verified-load, and exact-turn feedback evidence. Preserve distinctions among candidate exposure, injection, verified loading, explicit relevance judgment, and demonstrated task benefit.
- **R5:** Automatically surface evidence-backed runtime improvement hypotheses. The user must not be required to identify a repeated workflow or explain what the system should learn before this process can run.
- **R6:** Every proposed experiment identifies the observed problem, supporting evidence, bounded change, expected benefit, and a falsifiable comparison with the current baseline.
- **R7:** Preserve unknowns: absent reads, incomplete traces, prior-session skill carry-over, and rejected injections must not automatically become negative relevance labels. Keep behavioral proxies separate from user judgments and outcome evidence.

**Evaluation and control**

- **R8:** Use a versioned, session-held-out evaluation set grounded in real tasks; keep evaluation cases separate from cases used to choose or tune a change. Report coverage and uncertainty, and avoid repeatedly tuning to the held-out set.
- **R9:** Compare usefulness alongside unnecessary injection, context cost, latency, and available task-outcome evidence. Declare the experiment's primary metric and regression limits before running it; do not conceal trade-offs in one opaque score.
- **R10:** Tie evaluated and activated behavior to identifiable versions of the relevant runtime policy, skill inputs, and evaluation evidence. A comparison must remain interpretable after the library changes.
- **R11:** Report what changed, why, what improved or regressed, and what remains unproven in a concise user-facing result. Preserve the prior behavior so activated changes can be undone.
- **R12:** Keep raw private session evidence local by default. External evaluation requires approval of the actual payload; do not broaden existing data access or treat prior model approvals as blanket permission.

## Acceptance Examples

- **AE1 — No applicable skill.** A turn without an applicable skill produces abstention, not a forced recommendation. Evaluation treats appropriate abstention as valid. Covers: R1, R2.
- **AE2 — Loaded but unwanted.** The agent reads a suggested skill and the user labels it irrelevant. Retain the read and the judgment separately; do not count the read as proof the recommendation helped. Covers: R4, R7.
- **AE3 — Hidden counterfactual.** A gate blocks a shortlist and no skill is loaded. The system does not conclude the shortlist was useless or use that observation alone to justify stricter gating. Covers: R7.
- **AE4 — Composition regression.** A candidate causes two individually relevant skills to be loaded, but their combined guidance conflicts or raises context cost beyond the declared limit. Increased load rate alone cannot establish a win. Covers: R3, R9.
- **AE5 — Weak evidence.** A suspected recurring failure has too few reliable observations. The process reports the hypothesis and evidence gap rather than asserting an improvement. Covers: R5, R6, R11.
- **AE6 — Failed candidate.** A candidate improves its primary metric but violates a declared regression limit. Report the trade-off and retain the baseline rather than calling it a successful improvement. Covers: R9, R11.

## Success Criteria

- Demonstrate one complete evidence → hypothesis → bounded experiment → baseline comparison cycle without asking the user to diagnose the usage pattern.
- Produce a reproducible held-out comparison that distinguishes behavioral proxies from relevance and outcome evidence, with explicit exclusions and uncertainty.
- For an activated candidate, compare future use with the prior behavior and retain an undo path. An inconclusive or losing experiment remains a valid learning result, not a claimed product improvement.
- Keep user attention focused on framing and consequential choices rather than routine labeling, raw-log inspection, or experiment operation.

## Scope Boundaries

- **First slice:** existing-skill runtime improvement, supporting evidence analysis, and trustworthy evaluation. Do not expand this into a general agentic engineering platform.
- **Later:** session-history proposals for new skills or improvements to existing skills, plus a review service supporting acceptance, edits, and rejection. These are intended follow-on capabilities, not prerequisites for the runtime-first slice.
- **Excluded:** general memory generation, team sharing, marketplace distribution, and a general non-technical personalization product.

## Key Decisions

- Runtime first was explicitly selected and the resulting scope confirmed.
- Improvement opportunities should be discovered by the system, not supplied as mandatory user examples.
- Reuse the existing evidence foundation; do not confuse accumulating a dataset with closing the loop.
- No authorization for automatic production activation was established in this brainstorm. Planning and offline experiments do not imply permission to change live behavior.

## Dependencies / Assumptions

- Existing evidence sources are implemented in `src/usage-events.ts`, `src/usage-turn-dataset.ts`, and `src/skill-usage-feedback.ts`. Historical evidence limitations are documented in `docs/agent-skill-use-labeling-initial-analysis.md`.
- Production evidence sufficiency and trace completeness require an audit; this document makes no claim that current data can establish causal task benefit.
- Initial experiments can be evaluated without modifying live runtime behavior. Any active rollout remains a separate approval boundary.

## Outstanding Questions — Deferred to Planning

- Audit the current runtime path and existing offline experiment work before choosing the first bounded hypothesis; avoid duplicating work in `docs/plans/2026-10-16-001-skill-gate-offline-experiment.md`.
- Determine what reliable task-outcome and composition evidence can be recovered from current traces, and what minimal additional observations are needed. Do not equate a replayed recommendation with a rerun of task execution.
- Select an initial task suite, graders, uncertainty treatment, and predeclared comparison limits appropriate to the available evidence.
- Determine how to compare live behavior without mislabeling censored outcomes or claiming causal benefit from observational changes alone. Any exploration that changes exposure needs explicit approval.
