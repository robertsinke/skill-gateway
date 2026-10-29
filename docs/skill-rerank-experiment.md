# Skill reranking experiment — conservative trial

**Status:** enabled for Pi at the user's request; exploratory only. The user approved treatment sessions using `relevance-v2` with cutoff `0.1`, after the offline evaluation below. The unchanged control still receives the ordinary gated shortlist. This is not a validated population-wide improvement.

## Offline evidence — 2026-10-23

A frozen replay covered 58 turns from 12 sessions: 35 relevant and 228 not-relevant per-skill labels. Four turns were excluded for incomplete candidate descriptions. Unlabeled candidates stayed unknown. Both judgments used identical prompts, candidate metadata and labels; no histories, feedback or skill bodies were sent to Jev.

| Selection policy | Relevant retained / 35 | Irrelevant retained / 228 |
|---|---:|---:|
| Keep all candidates | 35 | 228 |
| Retrieval top one | 16 | 40 |
| Retrieval top three | 29 | 133 |
| Original material-help judgment, cutoff 0.5 | 23 | 48 |
| Relevance judgment, cutoff 0.5 | 26 | 55 |
| Relevance judgment, cutoff 0.1 | 35 | 161 |

The wording variant separates relevance from necessity and overlap, explicitly allowing supporting skills. At the fixed 0.5 cutoff it recovered three relevant labels while keeping seven additional irrelevant ones. The low-cutoff trial preserves every observed relevant label and removes 67 irrelevant suggestions, but **0.1 was inspected on development data, not independently validated**.

Whole-session-held-out cutoff calibration, targeting 95% training recall, retained 32/35 relevant labels for both wordings. The relevance variant retained 112 irrelevant labels versus 145 for the original, but fully missed one positive turn. Neither calibration result establishes the target recall out of fold. Do not present the post-hoc 0.1 result as a held-out win.

There were 116 successful Jev requests across both offline runs, with calculated input cost $0.00673218. The live-log join found only four feedback-linked rerank decisions; those are not sufficient for an arm-level effectiveness claim.

## Reproduce and inspect

```sh
npm run eval:skill-runtime -- --output <fresh-private-source-directory>
npm run eval:skill-rerank -- --run <source-directory> --output <fresh-private-batch-directory> --judgment current-v1
npm run eval:skill-rerank -- --batch <batch-directory>
```

Use `--judgment relevance-v2` at preparation time for the alternative wording. To compare judgments, freeze the same descriptions and assert identical case states/labels; independently reading a changed library is not a paired experiment. Each private batch preserves the exact outbound bodies. Existing batches without a judgment field retain `current-v1` semantics.

Only explicit authorized execution sends data:

```sh
npm run eval:skill-rerank -- --batch <batch-directory> --execute --max-cost-usd 0.01
npm run eval:skill-rerank -- --batch <batch-directory> --report --output <fresh-private-report-directory>
```

All output directories must be fresh and outside the repo, with an existing parent. Files are private, hash-verified, and not committed. Execution is sequential, budget-checked using reported or estimated tokens, and reserves attempts durably before calling the provider. Estimates are not a provider-enforced billing cap. There are no automatic retries; unresolved attempts and concurrent execution are refused. Resume only attempts that were never reserved.

Reports compare common scored cases, expose failed/pending requests, and separately project the runtime's keep-all fallback on completed errors. Rank metrics exclude missing rank labels with counts. The historical field `current_reranker_0_5` means the fixed 0.5 cutoff of the report's named judgment, not the installed trial cutoff. Skill-specific diagnostics stay in a separate private file, not default stdout.

**What the case count is and is not.** A label exists only for a skill the host actually injected: the feedback UI asks about suggestions the user saw. A turn where the gate declined, failed, or found no candidates therefore contributes no label and no case, which is why the prepared case count is a sample of *labelled passing turns*, not of all turns. Failed gates are reported separately as coverage (`failed_gate_turns`), and the live exclusions distinguish a gate that declined (`gate_declined`) from a gate that never answered (`gate_failed`), so a run that silently lost turns to timeouts cannot be read as a run that found nothing to inject.

`gate_not_passed` is a legacy fallback and should normally never fire: it only counts a turn whose gate rows are missing or duplicated, where neither decline nor failure can be named. Seeing it in a report means the gate/rerank evidence for that turn is malformed, not that the gate said no.

Live records now carry `rerank_policy`, `rerank_judgment` and `rerank_threshold` in both treatment results and control gate rows. The evaluator reports recorded policy groups separately, rejects contradictory arms/hashes/candidate lists, and never reclassifies historical selections using today's threshold. Preserve the policy boundary when reviewing fresh feedback; skill loads remain a behavior proxy, not relevance labels or task success.

## Current Pi behavior

The local Pi `userPromptSubmit` manifest entry is set to `SKILL_GATEWAY_RERANK_MODE=experiment` and limited to the `pi` agent. Stable sessions split 50/50: control keeps ordinary top-five injection; treatment runs the reranker after the existing gate and injects its selected skills. Restart Pi if its hook bridge caches the manifest. This is exploratory, not an approved final prompt design.

## What the prototype asked

The existing gate asks one Jev Noul over the prompt and up to five skill names/descriptions:

> Would an agent, given this current user request and exact shortlist, explicitly load at least one listed skill now to complete the task?

The reranker then asks one independent Noul per candidate:

> Does this candidate materially help complete the user's specific request?

A probability of `0.5` was used as the cutoff. These are the prototype's literal decision shapes, **not approved final prompts or calibrated thresholds**.

## Why it is not a valid quality experiment yet

- “Would load a skill” is a proxy for agent tool behavior, not a clean judgment of whether skill instructions materially improve task completion.
- The reranker sees names and short descriptions, not the skill procedures/excerpts that distinguish similar skills.
- Independent per-skill yes/no judgments support multiple winners, but do not compare candidates, detect redundancy, or reason about complementary combinations. It is not a true ranking question.
- The `0.5` fit cutoff was uncalibrated. A single synthetic smoke test confirmed that the code could change five candidates to one; it did not measure task quality or user preference.
- The v5 usage-turn dataset remains unchanged. `eval:skill-rerank` now joins raw rerank/gate events to its turns using exact user/session/turn keys, prompt hashes and candidate lists. It separates policy versions and uses recorded selections rather than guessing historical cutoffs. There are still too few feedback-linked live events for a causal arm comparison.

## Before re-enabling treatment

Agree on the distinct judgments and their evidence first: whether a skill is needed at all; which candidate(s) provide a distinct, task-relevant procedure; and whether multiple skills are complementary or redundant. Decide whether the candidate judgment should be a shortlist-wide Choice, independent per-skill Noul/Score, or a deliberate combination, with wording that makes the judgment target and counterfactual explicit. Supply enough candidate evidence to distinguish lookalikes while bounding prompt size and data disclosure. Then test the exact frozen payloads against labeled prompts offline, including multi-skill cases, and calibrate thresholds before a controlled live comparison.

A later live comparison should assign whole sessions to control/treatment, retain the unchanged top-five control, inject every accepted candidate in treatment (so multiple skills remain possible), fall back safely on errors, and compare explicit per-skill user labels separately from verified loads (which are only a behavior proxy). Report request cost/latency and uncertainty by session; prompts within one session are not independent samples.

## Prototype mechanics and privacy

When explicitly enabled with `SKILL_GATEWAY_RERANK_MODE=shadow`, the prototype only records proposed selections. With `experiment`, it assigns stable sessions 50/50 by a SHA-256 hash, calls Jev after the existing gate passes in treatment sessions, and originally injected all scores at or above `0.5`; the approved conservative trial now uses relevance judgments at `0.1`. An error falls back to the top five. The second request has a 2-second timeout. Both modes send the prompt plus up to five candidate names/descriptions to TypeSafe and incur billed usage when called. Neither sends skill bodies. The local Pi manifest is currently set to `experiment` at the user's request while the decision design is reconsidered.

Prototype outcomes and request metrics are appended to the private mode-`0600` `~/.local/share/skill-gateway/usage-events.jsonl` as `skill_rerank_shadow` or `skill_rerank_experiment`; gate rows include `experiment_arm`, `rerank_status`, and proposed names. Prompts are represented by a hash in this log. Keep user feedback and verified-load observations distinct.
