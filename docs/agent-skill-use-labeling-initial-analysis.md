# Agent skill-use labels: initial analysis

**Status:** Expanded evidence; baseline operational label agreed; local-only analysis

**Date:** 2026-10-14

## Decision being labeled

Treat an agent's **actual load/read of a skill's `SKILL.md` after receiving a user turn** as a behavioral proxy for that skill's contextual relevance. The agent already has the conversation context; choosing to load the skill is the observed decision. Per the experiment framing, treat that choice as the positive label—not as an independent claim of objective correctness.

Keep these outcomes distinct:

- **Injected skill loaded:** the agent read/loaded a skill that was in that turn's injected shortlist.
- **Other skill loaded:** the agent read/loaded a skill absent from the shortlist; this is a possible retrieval miss, not an abstention.
- **No skill loaded:** no explicit skill load was observed after a non-empty shortlist was injected.
- **Unknown / no candidate:** no reliable injection evidence, or the shortlist was empty. Do not label these as negative examples.

A native skill-loading tool (for example OpenCode's `skill` tool or a `skills_read_skill` call) counts as a load, as does reading a `SKILL.md` path directly. Search-only calls do not count as skill use.

## Dataset and evidence

The current preference dataset contains **284 sessions, 823 user turns, and 2,952 user/assistant messages** from a recent seven-day window, restricted by its generator to `inhouse-os` and its worktrees. Platform counts:

| Platform | Sessions | User turns |
|---|---:|---:|
| Cursor | 209 | 593 |
| OpenCode | 66 | 196 |
| Pi | 8 | 27 |
| Codex | 1 | 7 |
| **Total** | **284** | **823** |

Cursor is excluded from this label pass, per the user's instruction that it does not inject this shortlist. The injection-evidence pass therefore covers the other **230 turns**.

Evidence was joined from:

- `~/.local/share/skill-gateway/smeval-user-preference-review.jsonl` — per-session messages and user-turn indices.
- `~/.local/share/skill-gateway/queries.jsonl` — retrieval candidate lists and session/timestamp metadata. Its `selected` and `completed` fields are null; transcript prompt context is authoritative for what was actually injected.
- Each dataset row's `source_path` — raw agent transcript/tool events used to identify skill reads/loads.
- `src/prompt-hook.ts` and `src/query-log.ts` — shortlist formatting and logging behavior.
- `~/.local/share/opencode/agentfm/hook-events.jsonl` — older OpenCode lifecycle/permission events; it does not retain shortlist text.
- Agent session stores under `~/.claude/projects`, `~/.pi/agent/sessions`, `~/.codex/sessions`, and the OpenCode database — direct prompt-context and tool-read evidence.
- `~/.local/share/skill-gateway/prepare-preference-dataset.py` — source scope and extraction behavior.

No session history was sent to Jev. The existing SMEval datasets and the original preference dataset were not modified.

## Initial results

Reliable injected-shortlist evidence was found for **226 turns**: 195 OpenCode, 25 Pi, and 6 Codex. Four of the 230 non-Cursor turns have no matching injection record in this dataset; treat them as unknown, not as “no skill.”

Across the 226 logged turns:

| Observed outcome | Turns |
|---|---:|
| Loaded at least one injected candidate | **80** |
| Loaded skill(s), but none from the injected shortlist | **22** |
| No explicit skill load observed | **124** |

Ten of the 226 shortlists were empty (8 OpenCode, 2 Pi). Exclude empty-shortlist turns from negative examples. There were therefore **216 turns with at least one candidate**, and the agent loaded an injected candidate on **80 (37%)** of them. One turn loaded two injected skills, so those 80 turns represent **81 candidate-skill loads**.

Rank of the loaded injected skill(s), by shortlist position:

| Rank | Loads |
|---:|---:|
| 1 | 59 |
| 2 | 10 |
| 3 | 3 |
| 4 | 4 |
| 5 | 5 |

The most frequently loaded injected skills were `reviewloop` (36), `ce-commit-push-pr` (10), `ce-doc-review` (6), `greploop` (5), `slay-tasks` (4), `no-mistakes` (4), and `slay-browser` (4). These are load events, not counts of unique skills or users.

### By platform

| Platform | Shortlist evidence | Injected candidate loaded | Other skill only | No explicit load |
|---|---:|---:|---:|---:|
| OpenCode | 195 turns (8 empty) | 67 | 20 | 108 |
| Pi | 25 turns (2 empty) | 9 | 2 | 14 |
| Codex | 6 turns | 4 | 0 | 2 |

These are observed tool/read actions, not the hook's `selected` field (which is unpopulated).

## Data hygiene finding

In **195 OpenCode turns**, the injected “Skill library shortlist” and its descriptions are appended to the stored user-message text. In all 195 cases, the text before that marker exactly matches the original query in `queries.jsonl`. The current dataset extractor therefore mixes injected catalog content into the user message.

Before building Jev context, strip the appended shortlist/search-instruction block from every affected user message. Retain the shortlist separately as label evidence; do not include its names or descriptions in Jev's input.

## Interpretation and next evidence pass

The observed behavior is a useful training/evaluation signal under the agreed convention:

- A loaded injected candidate is a positive relevance label.
- A different loaded skill is a separate “candidate missing” signal.
- No load is a negative only when a non-empty shortlist is known to have been injected.
- Empty shortlists and missing injection records are excluded/unknown.

This remains a behavior-derived signal, not an independent accuracy estimate. The expanded sweep below excludes Cursor and searches older agent histories and adjacent project roots. Any eventual cleaned/labeled data should remain separate from the raw datasets.

## Expanded evidence sweep

**Historical snapshot cutoff:** query-log records before `2026-10-14T13:26:40.214Z`. This excludes the prompts in this analysis thread and later concurrently appended records; `queries.jsonl` is live and has grown since the cutoff.

### Coverage recovered

At the cutoff, `queries.jsonl` contained **504 records**. **493** could be tied to an agent transcript/turn: 195 OpenCode, 167 Pi, 130 Codex, and one Claude Code turn. Eleven query records remain unlinked. A separate Codex developer-context scan found **one additional injected shortlist block** with no matching query-log row. After deduplicating duplicate Claude attachment records, this is **494 direct injection contexts**.

| Platform | Injected contexts | Injected skill read | Other skill only | No explicit skill read | Empty shortlist |
|---|---:|---:|---:|---:|---:|
| OpenCode | 195 | 67 | 20 | 108 | 8 |
| Pi | 167 | 35 | 8 | 124 | 16 |
| Codex | 131 | 29 | 6 | 96 | 14 |
| Claude Code | 1 | 0 | 0 | 1 | 0 |
| **Total** | **494** | **131** | **34** | **329** | **38** |

### Agreed baseline label

For a **non-empty** injected list, label the turn `selected` if any listed skill is explicitly read/loaded after injection; otherwise label it `not selected`—operationally irrelevant to the agent for that turn. This is a behavioral label, not a claim about semantic usefulness. On the raw observed counts, that yields 131 selected (28.7%) and **325 not selected (71.3%)** across 456 non-empty lists. The not-selected set includes turns that loaded a different skill as well as turns with no skill read; retain that distinction as a sublabel.

Do not label empty lists or unlinked/incomplete traces. Also mark separately (or exclude) turns where a candidate was already loaded earlier in the same session: no new read may reflect carry-over rather than non-selection. The 325 negatives are therefore a raw baseline pending that carry-over check. The additional unlogged Codex context and Claude turn each had a non-empty list and no observed skill read.

**Provisional labels by evidence slice:**

| Slice | Non-empty lists | Selected | Not selected | Selected rate |
|---|---:|---:|---:|---:|
| Original recent inhouse-os/worktrees sample | 216 | 80 | 136 | 37.0% |
| Additional query-log records outside that scope | 238 | 51 | 187 | 21.4% |
| Two additional contexts omitted from the original dataset | 2 | 0 | 2 | 0.0% |
| **Total** | **456** | **131** | **325** | **28.7%** |

**Provisional labels by platform:** OpenCode: 67 selected / 120 not selected of 187 non-empty; Pi: 35 / 116 of 151; Codex: 29 / 88 of 117; Claude Code: 0 / 1 of 1. These comparisons are descriptive only: platform, project, time period, shortlist length, and trace completeness differ.

The most frequently loaded injected candidates in this wider snapshot were `reviewloop` (36), `executor-mcp-gateway` (11), `ce-commit-push-pr` (11), `typesafe-ai` (6), `aside-browser` (6), and `ce-doc-review` (6). These are skill-load events; a turn may load more than one candidate.

### Label artifact

Created a separate, metadata-only artifact:

- `~/.local/share/skill-gateway/smeval-skill-selection-labels-v2.jsonl` — current 505-row artifact: 494 transcript-grounded injection contexts and 11 query-log-only unknowns. Labels: 131 `selected`, 325 provisional `not_selected`, 38 `unknown_empty_shortlist`, 11 `unknown_unlinked_query`.
- `~/.local/share/skill-gateway/smeval-skill-selection-labels-v2.meta.json` — snapshot, schema, and aggregate counts. The initial `smeval-skill-selection-labels.jsonl` and `.meta.json` are preserved but superseded after an audit found candidate-parser defects.
- `~/.local/share/skill-gateway/prepare-skill-selection-labels.py` — reproducible v2 builder; refuses to overwrite existing outputs.
- `~/.local/share/skill-gateway/smeval-skill-selection-carryover-flags.jsonl` — positive-only per-turn flags for 112 carry-over-sensitive negatives; absence from this file does not prove no carry-over.
- `~/.local/share/skill-gateway/smeval-skill-selection-carryover-flags.meta.json` and `audit-skill-selection-carryover.py` — audit summary and reproducible read-only scanner. V2 labels were not changed.
- `~/.local/share/skill-gateway/smeval-any-skill-behavior-splits.jsonl` and `.meta.json` — 456 eligible turns assigned to deterministic, session-held-out folds; labels and carry-over flags only, no prompt text.
- `~/.local/share/skill-gateway/prepare-any-skill-behavior-splits.py` — reproduces the split manifest and refuses to overwrite existing outputs.
- `~/.local/share/skill-gateway/smeval-any-skill-behavior-inputs.jsonl` — initial local input build; retained unchanged.
- `~/.local/share/skill-gateway/smeval-any-skill-behavior-inputs-v2.jsonl` and `.meta.json` — current local inputs. Adds positive-only prior-load evidence as an input feature and separates targets into loaded, no-load with known prior overlap, and no-load with no overlap detected. The latter is still a weak negative; no-overlap does not prove no prior load.
- `~/.local/share/skill-gateway/prepare-any-skill-behavior-inputs.py` — read-only source reconstruction and separate-output builder. It does not call a model. Hidden system/developer prompts and tool-result payloads are not reconstructed.
- `~/.local/share/skill-gateway/score-any-skill-behavior.mjs` — Jev scoring runner; `smeval-any-skill-behavior-predictions-jev-1.13.0.jsonl` and `.meta.json` store local predictions and usage. The approved run scored 435 rows; 21 oversized histories were skipped without truncation.
- Initial candidate-aware results: raw Jev AUC 0.833 and Brier 0.185 versus a session-fold base-rate Brier of 0.205. Five-fold, session-held-out Platt calibration reduced Brier to 0.154. At raw threshold 0.5, precision was 0.541 and recall 0.800. Carry-over-flagged rows were reported separately; no production threshold was selected.
- `~/.local/share/skill-gateway/score-any-skill-presearch.mjs` and `smeval-any-skill-presearch-predictions-jev-1.13.0.jsonl` — approved conversation-only Jev test for a pre-search gate. It scored 437 rows; 19 oversized histories were skipped, with no errors.
- Pre-search result: AUC 0.489, Brier 0.391, and 30% precision at threshold 0.5. It would allow 349/437 prompts, so it does not solve over-injection. On the same 435 rows, the candidate-aware test reached AUC 0.833. Recommendation: keep search internal and gate before injecting its candidates; a conversation-only gate is not supported by this experiment.
- The live gate is installed in `src/prompt-hook.ts`: it evaluates the current user prompt plus up to five local candidate names/descriptions, then injects only on a pass. It fails closed. `usage-events.jsonl` is the append-only, metadata-only exhaust: `gate_decision` events record candidates, score, threshold, latency and session/turn IDs with a prompt hash; a `hooks-use`-managed `PostToolUse` observer records verified `skill_load` events without paths or tool output. Existing `queries.jsonl` still contains prompt/follow-up records. Unlike the offline candidate-aware evaluation, the hook does not receive full session history, so live performance remains to be measured.
- Important: a gate rejection censors whether the agent would have loaded a skill. Do not label rejected turns as “not useful”; only observed skill reads and explicit user feedback provide outcome evidence. The current next-message reaction heuristic is weak, not ground truth.

The 325 provisional negatives split into 30 turns with only an outside-list skill loaded and 295 with no explicit skill read. The artifact contains no user prompt text, shortlist descriptions, or tool outputs; it records only skill names and local source references. Existing SMEval datasets were not modified.

### Codex shortlist mismatch audit

The first artifact's candidate parser sometimes treated description fragments as skill names. V2 now requires the actual `name — absolute path — description` format. It corrected parsed candidate lists in nine Codex rows; **no label assignments changed**. The corrected comparison has **449 exact matches and 44 mismatches** among 493 session/time-linked query rows; all 44 are Codex, with timestamps within 51 ms. In every mismatch, the transcript list is an ordered subset of the query-log list—no transcript-only candidates were found. The 44 rows omit 130 logged candidates in total, concentrated at ranks 9–14.

Examples (query-log line; logged count → transcript count; logged-only names): line 61, **20 → 18**, `hooks-use`, `herdr`; line 62, **20 → 17**, `agent-first-crm-builder`, `boxd-setup-preview`, `source-feeds-builder`; line 69, **20 → 16**, `ce-setup`, `cmux-config`, `cmux-freestyle`, `worldbuilding`. The v2 artifact uses the transcript shortlist and records the query-log line and exact-list-match flag.

The current formatter emits every hit with a name and path, while the query logger records hit names; neither appears to implement this selective omission. Current `~/.codex/hooks.json` invokes `prompt-hook.js` directly with a 10-second timeout, alongside other `UserPromptSubmit` hooks (not through Caveman). The precise cause—Codex delivery/serialization or another integration behavior—remains unresolved. Treat transcript context as the best available record of what was presented, and do not use the query-log list as the injected candidates in mismatch rows.

The 266 query records outside the original recent inhouse-os/worktrees scope came from Pi (142) and Codex (124); there were no additional OpenCode query records outside that scope. Those 266 yielded 51 injected-skill reads, 12 other-skill-only turns, and 203 with no explicit read; 28 lists were empty. The extra direct-only Codex block was in an Aside session. The Claude transcript was in an inhouse-os worktree, but Claude was not part of the original dataset builder.

The expanded projects include `inhouse-brand`, `personal-OS`, `inhouse-cloudflare-os`, `skill-gateway`, `inhouse`, and Codex's home-directory and task-folder sessions. Largest added cwd roots: Codex `/Users/robert` (71 turns) and `inhouse-brand` (40); Pi `skill-gateway` (37), `personal-OS` (33), `inhouse-cloudflare-os` (33), `/Users/robert` (30), and `inhouse` (9). The remaining six roots account for 13 turns. The query-log evidence spans Sep 24–Oct 14: Codex Sep 24–Oct 12, Pi Sep 25–Oct 14, OpenCode Oct 9–13, and the one Claude turn on Oct 9. Some older Codex shortlists contained 15+ candidates, unlike the common five-item lists in the recent sample; compare decisions per injected list rather than assuming a fixed shortlist size.

### Evidence boundary

Raw transcript scans found direct shortlist markers as early as Sep 24 in Codex, Sep 25 in Pi, and Oct 9 in OpenCode; Claude has one Oct 9 example. No earlier shortlist markers or rotated query-log files were found. OpenCode's `agentfm/hook-events.jsonl` reaches back to Aug 6 and records lifecycle/permission activity. Some permission inputs refer to skill-file paths as early as August and Sep 21, but the log does not preserve the injected shortlist or prove the file read completed. Those events cannot be paired with candidates and are not labels.

Eleven query records still lack a recoverable transcript. One missing OpenCode session has only status events in the hook log; that is insufficient to infer a skill-read decision. The direct-only Codex shortlist is counted from its developer context, not from a query-log record.

### Carry-over sensitivity and trace spot-check

A read-only scan of prior same-session transcript history found that **112 of 325 provisional `not_selected` turns (34.5%)** had at least one shortlisted skill explicitly read earlier in that session. These turns contain 142 prior-load/candidate overlaps. Counts: Codex 22/88, Pi 25/116, OpenCode 65/120, Claude 0/1. The scan used prior tool events across the session, constrained to transcript ancestry for Pi/Claude and prior event order for Codex/OpenCode; it found no additional affected turns beyond the injection-turn-only first pass.

This is carry-over exposure, not proof that the skill remained active or explains the later non-read. The v2 labels remain unchanged and unadjusted; their `carryover_checked: false` field remains as generated. The separate flag file lists only positive evidence and skill names. As a conservative turn-level sensitivity, withholding all 112 leaves 213 provisional negatives, but that should not replace the baseline without choosing turn-level versus candidate-level treatment.

A raw-source spot-check matched shortlist extraction and skill-read traces for one row per platform: selected Pi, Codex, and OpenCode examples had candidate reads 10.920 s, 4.986 s, and 12.922 s after injection; Claude's only row had a five-skill shortlist and no skill read. This validates examples, not every row. OpenCode's appended shortlist/descriptions remain excluded from context text.

Do not send shortlist content, tool traces, or histories to Jev until the input contract is agreed. Keep the labeled artifact separate; the original datasets remain untouched.
