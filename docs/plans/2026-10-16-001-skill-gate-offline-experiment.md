---
title: Skill runtime first experiment — gate wording and evidence baseline
type: feat
status: active
date: 2026-10-16
updated: 2026-10-17
origin: docs/brainstorms/2026-10-17-skill-runtime-improvement-loop-requirements.md
---

# Skill runtime first experiment

## Summary

Extend the existing offline experiment with a local, reproducible evaluator, then compare the current gate wording with one frozen candidate on identical inputs from untouched sessions. Keep retrieval and composition diagnostic, preserve production behavior, and treat insufficient independent evidence as an inconclusive result rather than forcing a winner.

## Problem Frame

The runtime collects evidence but does not yet turn it into a reproducible, evaluated change. The earlier six-negative pilot suggests a gate-wording hypothesis, but its selected examples cannot independently establish an improvement. This experiment is one bounded slice of the runtime-first requirements, not delivery of the full improvement loop.

## Requirements and Scope

- Origin R4–R8: reuse exact-turn evidence, automatically surface supported hypotheses, separate proxies and judgments, and protect held-out evaluation.
- Origin R9–R12: predeclare comparisons, identify versions, report uncertainty and regressions, and preserve privacy and reversibility.
- Origin R1–R3: distinguish retrieval, gate, loading, and composition in diagnostics; do not claim this gate experiment validates downstream task benefit or composition quality.
- Origin actors A1–A3 and flows F1–F3 apply. Acceptance examples AE2, AE3, AE5, and AE6 are directly covered; AE1 and AE4 inform diagnostics but require later execution-level evaluation for full coverage.
- No changes to live thresholds, payloads, ranking, skill content, feedback UI, or runtime telemetry. No external calls without fresh payload-specific approval. New-skill generation and review service remain follow-on work.

## Context and Verified Baseline — 2026-10-17

A read-only, in-memory rebuild using `buildUsageTurnDataset` found 188 turns, all `matched_hash`: 16 explicit yes, 20 no, 3 unsure, 149 without an injection decision. Yes/no labels span only 7 sessions; all 36 have one valid gate observation. There are 51 turns with any feedback, 37 with per-skill labels, and 41 with verified loads. Unlinked source counts are 28 gate events, 11 load events, and 590 query rows; report these separately rather than silently joining them.

The saved v5 dataset still contains 117 turns, 11 yes, 10 no, 2 unsure, across 4 yes/no-labeled sessions. Do not overwrite it to run this experiment. These live counts are observations, not frozen run inputs; U1 must snapshot again.

**Existing ownership:**

- `src/rank.ts` and `src/search.ts`: local retrieval. `src/prompt-hook.ts` defaults to five hits and gates at most the first five. Inspect `extensions/skill-gateway.ts` separately for Pi integration; do not assume every platform used the same deployed revision.
- `src/skill-gate.ts`: `buildSkillGateRequest`, `evaluateSkillGate`, model `jev-1.13.0`, threshold 0.5, fail-closed errors, 80,000-character state limit, 6,500 ms request timeout. Gate input is the current prompt and candidate names/descriptions, not full conversation history.
- `src/usage-turn-dataset.ts`: exact `(user_id, session_id, turn_id)` joins and query-hash matching; gate observations retain names/ranks/probabilities, not historical candidate descriptions or a payload revision.
- `scripts/build-usage-turn-dataset.ts`: existing generator defaults to overwriting the private v5 output. Reuse its underlying builder, but use a fresh private run directory for experiment artifacts.
- `src/holdout.ts` and `skills/holdout.json`: existing retrieval fixture checks are not a real-task, session-held-out gate evaluation. Keep their purpose unchanged.

No new dependency or service is needed. External research is deferred: this first experiment depends on local evidence contracts and the already installed provider integration, not a new evaluation framework.

## Key Technical Decisions

1. **One treatment:** change gate question wording only. Freeze the pilot's general material-help clarification as one candidate, including a positive case for explicit skill requests. Keep model, threshold, candidate list/order/descriptions, prompt, request envelope, and runtime limits identical. No ranking or threshold optimization in the primary comparison.
2. **Development versus test:** all examples and sessions previously inspected to craft wording are development-only. Recover provenance from private pilot artifacts/history, not guesses. If exposure cannot be established, conservatively treat all currently available sessions as development; use later sessions for confirmatory evaluation. Do not randomly split contaminated sessions.
3. **Replay is not historical reproduction:** freeze current descriptions once for both arms and hash them. Mark missing descriptions and exclude incomplete pairs. Since historical descriptions/payload revisions are absent, distinguish recorded historical probabilities from current baseline replay; never call the latter an exact historical replay.
4. **Proxy boundary:** loads can prioritize review, outside-shortlist loads can flag possible retrieval misses, and co-loads can flag composition questions. None supplies correctness labels, proves conflict, or demonstrates task success. Per-skill feedback is limited to exposed skills, so depth analysis is observed-label retention—not library-wide recall.
5. **Offline only:** local evaluation performs no network calls. Separate scoring requires an explicit execute flag and an approved, frozen outbound batch. A plan approval is not approval to send prompts or change production.

## Experiment Protocol and Decision Rules

**Hypothesis:** compared with current wording at threshold 0.5, the material-help clarification reduces false injections on explicitly negative turns without an unacceptable loss on explicitly positive turns.

**Eligibility:** primary gate metrics require a hash-linked query, explicit yes/no label, exactly one gate observation, finite probability in [0,1], nonempty unambiguous candidate list, and stable identity. Separate errors, empty candidates, duplicate gates, unknowns, and exclusions with denominators. Unsure is never a class label. Compare payload arms only on complete paired responses; also report all attempted rows and arm-specific invalid-response rates so exclusions cannot conceal failures.

**Before viewing test predictions:** freeze the candidate text, dataset/source hashes, code revision and dirty-tree patch hash, cohort membership, label snapshot, model, descriptions, request bodies, criteria, and analysis logic. Store identities only in private manifests; default reports are aggregate-only. Frozen test labels are not used for tuning. New labels or changed labels go into a later version, not a silently revised result.

**Primary metric:** paired change in balanced accuracy, with sensitivity to class and session counts. Report TP/FN for yes, TN/FP for no, positive recall, negative rejection rate, and raw disagreement counts. Show per-session variation without public session identifiers. Historical threshold sweeps are development diagnostics only; no threshold selection on test data.

**Predeclared practical candidate gate (necessary, not sufficient):** strictly better balanced accuracy than baseline; positive recall no more than 5 percentage points worse; invalid-response rate no worse; mean reported input-token cost no more than 10% higher; and p95 request latency no more than 20% higher under comparable execution. Interleave arm order deterministically to reduce order effects. Missing usage or insufficient latency observations make the corresponding guardrail unverified, not passed. These are initial experiment limits, not a production SLA.

**Uncertainty and stopping:** the 7-session historical slice is exploratory regardless of point score. For a prospective comparison, lock a 30-day collection window before inspecting predictions, include all eligible completed new sessions within it, and require at least 20 independent sessions and 30 labels in each yes/no class to attempt an uncertainty-qualified comparison. These are minimum reporting floors, not a power guarantee. Use a deterministic session-cluster bootstrap with 10,000 resamples for the paired balanced-accuracy difference; omit class-missing resamples and report their count. Report the 95% interval and do not claim a supported win if its lower bound is at or below zero or the minimum floors fail. Do not keep extending the same evaluation until it wins; any next window is a new registered experiment.

**Possible outcomes:** insufficient evidence, regression, no supported difference, or candidate worth human review. No outcome automatically authorizes deployment. Even a supported offline win establishes agreement with the labeled slice, not causal task benefit or all-platform quality.

**Composition diagnostic:** report observed co-load counts and evidence availability. Do not invent an automatic composition score from event metadata. A later task-execution suite must assess conflicting guidance and task outcomes.

## Implementation Units

### U1. Private frozen audit and baseline evaluator

**Goal:** replace ad hoc inspection with one local command and a clear evidence-quality report.

**Requirements:** origin R4, R5, R7–R12. **Dependencies:** none.

**Files:** create `src/skill-runtime-experiment.ts`, `scripts/evaluate-skill-runtime.ts`, and `test/skill-runtime-experiment.test.ts`; add `eval:skill-runtime` to `package.json`. Reuse the dataset builder without modifying runtime ownership.

**Approach:**

- Read source bytes once, identify malformed JSONL records (the current permissive reader silently skips them), and record hashes and byte lengths. Use captured bytes for the build; never hash one version and analyze another. Flag potentially inconsistent cross-file capture and missing/empty required sources.
- Write only to a fresh private run directory outside the repo: directory mode 0700, files 0600, exclusive creation, refusal to overwrite, atomic publication with a completion manifest. Keep raw source evidence and private cohort identifiers out of stdout and git.
- Produce linkage/label/rank coverage, stage diagnostics, historical gate confusion counts at recorded thresholds and fixed 0.5, and development-only threshold/depth tables. For depth 1/3/5, report labeled relevant retention, labeled irrelevant exposure, unlabeled exposure, and missing ranks separately; do not fabricate negatives.
- Produce supported follow-up hypotheses automatically from observed counts: gate disagreements, possible retrieval misses, and evidence gaps. Attach denominators and proxy warnings; only the already frozen wording hypothesis proceeds in this experiment.

**Test scenarios:** exact user/session/turn isolation; hash mismatch; malformed lines; missing file; duplicate gates; error with null probability; unsure/unlabeled; prior loads and rejected gates not recoded; missing ranks; no positives or no negatives yields undefined rates, not zero; privacy-safe output; overwrite refusal and restrictive permissions.

**Verification:** `npm run eval:skill-runtime -- --output <fresh-private-run-directory>` creates audit and baseline artifacts without network activity or mutation of existing datasets. All totals reconcile to captured inputs, including exclusions. This is a planned command, not yet implemented.

### U2. Freeze cohorts and approval-gated paired batch

**Goal:** build an inspectable, reproducible candidate comparison without accidental disclosure or contamination.

**Requirements:** origin R6, R8–R12. **Dependencies:** U1; source-provenance audit; fresh external-call approval for scoring.

**Files:** extend the U1 module, CLI, and tests; create `scripts/score-skill-runtime-experiment.ts`. Reuse `buildSkillGateRequest` to construct the baseline; keep candidate transformations in experiment code, not the live builder.

**Approach:**

- Freeze the current baseline body and candidate body, changing only question instructions/criteria. Assert equality of all other fields. Retain an exact private copy and digest of each outbound body, including current descriptions.
- Recover pilot exposure and exclude entire affected sessions. If uncertain, mark current data development-only. Freeze future-session eligibility and the collection window before viewing new outcomes. Keep all turns from one session in one cohort, including sessions that straddle cutoff boundaries.
- Dry-run locally by default. Show only endpoint, model, batch sizes, byte/token estimates, cost basis, changed fields, and private payload location for approval. External scoring sends only current prompt and frozen candidate metadata—not histories, feedback, comments, source paths, or identifiers.
- Require explicit approval bound to the batch digest, request count, endpoint, and estimated budget. Network execution has an explicit flag, bounded concurrency, an attempt ledger, and no automatic retries. Resume only unattempted approved requests; ambiguous failures require review rather than silent resending. Preserve timeout/state-size behavior and validate responses.

**Test scenarios:** mocked provider only; no network in dry run; approval mismatch fails before calls; missing descriptions; mutated batch; session overlap; repeated invocation; partial pairs; malformed/out-of-range answers; state limit; timeout; cost/usage missing.

**Verification:** a frozen batch is reproducible; no scoring occurs without a separately approved execute action. Prior approval for 12 pilot calls does not cover this batch.

### U3. Paired report and next-use handoff

**Goal:** produce an honest experiment result and explicit next action, not an automatic production patch.

**Requirements:** origin R5, R6, R8–R11. **Dependencies:** U1; U2 responses only for payload comparisons.

**Files:** extend U1 module/CLI/tests; update `README.md` with local commands and privacy warnings; append results to this plan only after execution. Keep detailed evidence in the private run directory.

**Approach:** report local baseline immediately; label any historical candidate comparison exploratory. Implement fixed criteria, paired metrics, cluster uncertainty, incomplete-pair accounting, and a concise outcome explanation. Publish counts and limitations without prompt text, comments, names, or identifiers. Record whether apparent gains vanish by session or positive class. A prospective window produces exactly one frozen report, not repeated winner checks.

**Test scenarios:** synthetic true improvement, positive-recall regression, class/session imbalance, no supported difference, too few sessions, failed guardrail, missing cost, all-invalid arm, deterministic resampling, and no production mutation. Include cross-layer CLI tests using temporary private logs and fake scoring responses.

**Verification:** a report distinguishes measured agreement from unmeasured task benefit and composition quality. A candidate recommendation links its frozen evidence and needs an explicit activation decision; rollback and subsequent live measurement are planned separately before any rollout.

## Verification and System-Wide Impact

During implementation, run focused tests with `node --experimental-strip-types --test test/skill-runtime-experiment.test.ts test/usage-turn-dataset.test.ts test/skill-gate.test.ts`, then `npm run typecheck`. No tests or model experiments are run during this planning task.

The change adds offline tooling only. It must not import startup side effects or modify prompt-hook, extension, API, or ranking behavior. Validate source-snapshot consistency, artifact permissions, error propagation, and no-network defaults at the CLI boundary. Existing unrelated work in `README.md`, `extensions/skill-gateway.ts`, `src/pi-gate-telemetry.ts`, and its tests must be preserved.

## Risks and Open Questions

- **Small, selective labels:** report selection bias, class/session counts, and abstain from broad claims; do not manufacture labels or require the user to label every turn. Passive evidence can select future evaluation opportunities but does not close the ground-truth gap.
- **Pilot provenance:** inspect existing private artifacts/history during U2. Missing exposure provenance forces a prospective test, not guessed holdout membership.
- **Model and library drift:** freeze current input descriptions and model identifiers; provider revision may remain opaque. Distinguish contemporary paired scoring from historical probabilities.
- **Low prospective label volume:** the collection window may fail minimum floors. That is an evidence-gap result, not a reason to relax criteria after scoring or continuously prompt the user for labels.
- **Composition and causal benefit remain unmeasured:** the first experiment does not satisfy the entire runtime-loop requirements. Later execution-level tests and an approved live rollout are needed to claim next-task benefit.

## Planning Review

Reviewed for: exact identity joins, stale saved data, test contamination, absent historical payloads, censored outcomes, malformed-input loss, privacy, paired-response attrition, repeated testing, and unsupported composition/task-success claims. The implementation is feasible with existing Node/TypeScript dependencies. Main evidence risk is independent labeled-session volume, not missing infrastructure.

## Sources and References

- Origin: `docs/brainstorms/2026-10-17-skill-runtime-improvement-loop-requirements.md`.
- Historical label caveats: `docs/agent-skill-use-labeling-initial-analysis.md`.
- Runtime and data ownership: `src/prompt-hook.ts`, `src/skill-gate.ts`, `src/usage-turn-dataset.ts`, `src/skill-usage-feedback.ts`, `src/usage-events.ts`.
- Existing pilot and original proposal are preserved below. Their next-step list is historical; the U1–U3 plan above governs subsequent work.

---

# Historical initial proposal — superseded by the plan above

## Goal

Determine whether the main opportunity is (a) fitting more relevant skills in the shortlist, or (b) deciding more accurately whether any skill should be injected. Test gate-payload wording and decision threshold separately, using existing explicit feedback as an initial offline evaluation set. Do not change production behavior as part of the experiment.

## Current baseline and constraints

The local v5 dataset currently has 110 turns. Thirteen turns have at least one explicitly relevant skill label (24 labeled relevant skills); 19 turns have an explicit injection decision: 11 `yes`, 7 `no`, 1 `unsure`. The recent top-k rank observation is 19/24 relevant skills at ranks 1–3, 5/24 at ranks 4–5. These are small, selective samples, not population estimates.

Available records include per-turn gate probability/threshold, candidate rankings and injected skills, per-skill `relevant` / `not_relevant` / `unsure` labels, and an injection decision. Exact user/session/turn IDs are the join key. Query matches, unlinked records, duplicate/latest feedback behavior, and missing labels must be reported. Keep prompts and user data local; do not send them to an external evaluator without explicit approval of the exact payload.

## Experiment questions

1. **Retrieval depth:** On labeled turns, what fraction of relevant skills appear in top 1, 3, and 5? How many labeled not-relevant candidates would each depth include? Report turns and skill-label counts separately.
2. **Any-skill gate:** At each threshold, how many explicitly `yes` decisions pass and explicitly `no` decisions reject? Report false-positive and false-negative counts/rates with denominators. Exclude `unsure` from primary rates and show it separately.
3. **Payload:** Does a changed gate payload improve agreement with explicit decisions at the same threshold? Only compare payload variants if probabilities are generated consistently for all examples; preserve the original payload/probability and record model/version.

## Design

### Phase 1 — data audit (local, read-only)

- Rebuild the v5 dataset from current source logs.
- Produce aggregate-only audit output: row counts, query-link statuses, explicit injection-decision distribution, relevance-label distribution, and label/rank coverage. Never print queries, comments, identifiers, or skill-level examples by default.
- Validate joins strictly on `(user_id, session_id, turn_id)` and flag missing/ambiguous evidence rather than inferring labels from skill loads.
- Freeze a snapshot/manifest for the evaluation run (dataset hash, generation time, code revision); preserve source logs.

### Phase 2 — baseline evaluation

- Use only explicit injection decisions for gate metrics; `unsure` is a separate abstention bucket, not positive or negative.
- Use explicit per-skill relevance labels for retrieval metrics. Unlabeled candidates are unknown, not negative.
- Report small-sample counts alongside rates. Avoid claiming statistical confidence or generalizing beyond the labeled slice.
- Establish fixed baseline metrics before testing any changes.

### Phase 3 — threshold sweep

- Apply a grid of thresholds to already-recorded probabilities, without making new model calls.
- For each threshold report confusion counts, positive/negative denominators, balanced accuracy (when both classes exist), and coverage; list `unsure` separately.
- Select a candidate threshold only if tradeoffs are acceptable on the existing labels; mark result exploratory due to sample size and possible feedback-selection bias.
- Do not tune and report performance on the same examples as an unbiased estimate. A future evaluation should use later, untouched labels or a fixed time-based holdout once there are enough examples.

### Phase 4 — payload comparison (only if useful and approved)

- Define at most two concise, materially distinct payload variants: current production payload and one candidate that clarifies the binary task, what counts as a skill need, and how to handle borderline cases.
- First inspect the exact payload builder, model/API constraints, privacy boundaries, and current threshold ownership. Do not log full prompt text in reports.
- Score variants on the same labeled examples with the same model/version and candidate list; record probability and response validity. Model calls may cost money and transmit query context externally: obtain explicit approval of the exact data/endpoint before running them.
- Compare payloads at a common threshold and compare their threshold sweeps separately. Do not attribute differences to payload if model, candidate list, or input data also changed.
- Keep production unchanged pending review of results.

## Acceptance criteria

- A reproducible local command generates aggregate-only results from the current dataset.
- Retrieval depth and gate threshold results show counts and denominators; `unsure` and unlabeled cases remain distinct.
- The report explicitly states sample size, data-linkage gaps, and selection bias, and does not treat passive behavior (e.g. skill loading) as ground truth.
- Payload variants, if evaluated, are paired on identical inputs and run only after explicit approval; no production threshold/payload changes are made by this experiment.

## Non-goals

- Automatically manufacturing ground-truth labels from loads, subsequent assistant behavior, or absence of use.
- Sending private prompts to Jev or another model without explicit approval of the exact payload and service.
- Changing live injection behavior, feedback UI, dataset schema, or source logs.
- Claiming the current 19 decisions are enough to establish a reliable operating threshold.

## Estimated setup

A minimal, local first pass should be about **1–2 hours** if the existing dataset and rank/probability fields are sufficient: audit rows, implement an aggregate evaluator, add focused tests, and run the threshold/depth tables. A payload comparison is a separate step (roughly **1–2 additional hours** to prepare and validate, plus model-call time/cost), and is gated on reviewing the outbound data and getting approval. Building a durable stream of less-biased labels is a separate design task; passive signals can prioritize review but cannot replace explicit judgment.

## Experiment log — 2026-10-16

### “Check” payload pilot

- User explicitly approved sending six hash-linked historical prompts labeled `injection_decision=no`, with their candidate names/descriptions, to Typesafe's Jev endpoint (`jev-1.13.0`). Each prompt was evaluated once with the current payload and once with a candidate wording: 12 calls total.
- At the existing threshold of 0.5, the current payload passed 5/6 examples on replay; the historical gate also passed 5/6. The clarified wording passed 1/6. Mean probability change (clarified minus current replay) was -0.305.
- Clarified wording: a generic request to check/review/verify does not by itself imply skill need; decide whether a candidate's specific procedure/expertise materially helps, and do not infer need from word overlap alone.
- This is a promising directional signal only: n=6, all are negative examples selected for containing “check”; wording is narrowly tailored and may overfit. Historical candidate names were retained, but descriptions were read from the current library because historical descriptions are not stored with gate events. No production settings or code changed.

### Current broader-label coverage

Latest dataset audit: 117 turns; 11 explicit `yes`, 10 explicit `no`, 2 `unsure`, and 94 unlabeled. For the semantic contrast, only one explicitly labeled “commit” turn exists (yes), three “review” turns (yes), and no exact “code review” examples. The six “check” negatives therefore do not establish how a generalized payload handles positive intent.

### Next time

1. Rebuild the dataset and verify counts before analysis.
2. Implement a local aggregate-only evaluator with label/linkage checks and report denominators; include retrieval depth, gate confusion counts, probability/threshold sweep, and intent slices for `check`, `commit`, `review`, and `code review`. Do not expose prompt text in output.
3. Decide whether to run an exploratory paired comparison on all 21 explicit yes/no turns. This may show direction but remains too small for a reliable broad conclusion. Ask for explicit approval before sending these additional prompts and candidate metadata to Jev; the prior approval covered only the six “check” negatives.
4. Collect more explicit positive and negative labels for ambiguous and strong-intent examples. Keep `unsure` separate; do not infer truth from skill loads.
5. Only consider production payload or threshold changes after broader evaluation; leave retrieval ranking unchanged absent positively labeled missing/relevant skills.
