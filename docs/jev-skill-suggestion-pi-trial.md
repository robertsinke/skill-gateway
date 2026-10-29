# Original Jev skill-suggestion approach in Pi

This opt-in port tests the actual TypeSafe path of [jev-skill-suggestion](https://www.aitmpl.com/component/mod/productivity/jev-skill-suggestion), not another tuning of the existing gateway reranker. The original pure policy is vendored **unchanged**, pinned to commit `4efb68547887d2a4dd714074bd7ecb4171dc9fee`; see `src/vendor/jev-skill-suggestion/UPSTREAM.md` and its MIT license.

## What stays the same

1. Rank **every skill**, not a keyword-search top five. At the same time, ask the original three questions about whether a skill is needed; invert the prose-only answer and average the available answers. Gate threshold: **0.30**.
2. Reconsider the **top three**, using their descriptions and the first **700 characters** of each skill body. Ask the original ranking and independent fit questions.
3. Use upstream's decision unchanged: reject when all returned fits are below **0.30**, otherwise accept its ranking winner only if it is on the allowed shortlist. This is an overall-fit check, **not** a new requirement that the winner's own fit exceed 0.30. Upstream permits absent optional gate/fit answers; the port preserves that behavior.
4. Attach **one complete skill body or none**, without listing the roster. Preserve the original “ignore this if it does not fit” qualification. Repeated selections name the already attached skill rather than repeatedly attaching its body.
5. Each request gets a **3 s** timeout instead of upstream's 800 ms, and no automatic retries. Measured on a 154-skill library: the ranking call takes 250–670 ms at rest but passes 800 ms whenever an agent is busy, so the original budget aborted about half of all BB turns and injected nothing. An attempted second request that fails gives no suggestion, not the first request's winner or the old top-five shortlist. The ledger records each attempt's phase, status, reason and latency, so a failed selection says `ranking timeout` rather than `no answer`.

## Pi-specific adaptation

- Uses Pi 1.3+'s `before_agent_start` and structured `systemPromptOptions.skills`, not string replacement of the system prompt. Only the skill section is hidden; other instructions are untouched. No Claude settings are edited.
- Candidates are Pi's loaded skill resources plus the merged Skill Gateway library, using original descriptions. Pi resources win name collisions. There is no BM25 prefilter.
- Uses Pi file paths and tells the model that inline instructions are already loaded; there is no Claude `Skill` tool. Claude skill-directory/project-directory placeholders are still expanded in the body.
- `disable-model-invocation` is honored. Missing bodies retain descriptions, as upstream does. Explicit `/skill:name` requests and custom-message runs do not trigger another selection.
- File/body caches reset on session changes, context-tree changes and compaction, so the next selection does not refer to instructions lost from context. In-flight results from a previous context are discarded.
- TypeSafe only: no Vercel Gateway or Claude built-in-classifier fallback. Missing credentials leave the existing chooser and native listing unchanged. Invalid/non-finite wire probabilities are rejected instead of influencing selection.

## Privacy and local evidence

The user approved sending the current prompt, all candidate names/descriptions, and up to 700 body characters for each of the top three candidates to TypeSafe for this trial. No conversation history, feedback or labels are sent to TypeSafe, and body excerpts never exceed 700 characters per candidate (a shorter body can fit entirely). The selected **full body goes into Pi's context**, so the main coding-model provider sees it just as it would when the agent reads a skill normally.

Local gate/query records include the distinct `runtime_policy`, exact generated turn ID, selected exposure, request timings, and reported/estimated costs. Inline attachment is **exposure, not evidence that the agent followed the skill correctly**. Turn IDs have source `pi_jev_extension`; they are not guessed from the old hook bridge's independent turn IDs. Old bridge tool-read events without matching IDs remain unlinked. Do not pool this trial with `relevance-v2-at-0.1` or claim historical arm comparisons establish improvement.

## Try it without changing global defaults

After the updated gateway `prompt-hook.js` has been deployed, start a separate Pi session:

```sh
pi -e /path/to/skill-gateway/extensions/jev-skill-suggestion.ts --jev-skill-suggestion
```

The flag explicitly enables the approved TypeSafe/excerpt path. Without it, the direct extension does nothing, unless a personal loader calls `registerJev(pi, { enabledByDefault: true })`. This machine now has that default-on loader at `~/.pi/agent/extensions/jev-skill-suggestion.ts`: reload Pi once, then use Pi normally without flags. `Jev original: …` in the status line confirms activation. A credential warning means it is **not** active.

The extension sets an in-process session marker inherited by the hook subprocess. The updated `prompt-hook` checks the exact Pi session ID and skips the old chooser only for that session, preventing two selectors from running together. Other agents, other sessions and the existing experiment are unchanged. Do not enable the trial against an older installed hook: it lacks this bypass. A prerequisite test verifies the bypass with the real hook handler.

To stop a flag-only trial: exit the trial session and start Pi without the flag. For the installed default-on loader, remove `~/.pi/agent/extensions/jev-skill-suggestion.ts` and reload Pi instead. No global skill overrides, roster removals, or model settings need restoring. The small installed hook update has a separate hash-guarded backup/rollback; reverting it is optional while the flag is unused.

## Proof

Verified locally on 2026-10-27: 181 tests, repository typecheck and a separate check against the installed Pi API. A real TypeSafe call with synthetic public skills chose the expected Git skill, using both original requests in 654 ms. A real Pi session considered all 153 available skills, hid the native roster and recorded exactly one chooser decision (the original one), then replied READY. With the ordinary global extension set its one-shot process remained alive after the response and was stopped after 90 seconds; with only this extension it completed and exited normally. The combined-extension shutdown behavior remains unresolved; the chooser itself completed. These checks do not establish better suggestions or justify altering the original policy.

Tests compare both request payloads and decisions directly against the pinned policy, including its non-obvious fit rule. They also cover excerpt limits, full-body local attachment, disabled skills, missing files, cache resets, malformed responses, failures/timeouts, consent, native-list hiding, per-session legacy suppression, and local audit joins. A passing port proves implementation parity and wiring, **not better suggestions**. Judge the actual trial on fresh usage and explicit feedback.
