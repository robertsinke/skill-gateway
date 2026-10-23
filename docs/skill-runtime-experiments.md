# Offline skill-runtime experiments

The offline tools do not change production behavior. Private prompts stay local unless scoring is explicitly authorized for a frozen batch.

## Active scoped gate trial

The live gate now applies the negative-criterion clarification only to a bare English `check`, `review`, or `verify`, optionally prefixed/suffixed by `please` and followed by `.`, `!`, or `?`. This is not an unconditional rejection: Jev still judges the shortlist. Requests such as `clean up`, `check PR #123`, `review this diff`, and `check the comments` retain the original payload and threshold.

This scope was selected after inspecting development results. Post-hoc replay retained 15/18 positive examples and reduced false injections from 32/40 to 27/40; all five scoped examples were negative labels from one session. That is exploratory evidence, not an independent win or proof about useful bare-check requests.

Offline comparison templates deliberately retain the **original pre-trial control**, not a silent reconstruction of the live scoped policy. Preview names that baseline policy. Existing experiment bodies/results are immutable.

Activation replaces only the installed gate JavaScript module, retaining a private original, deployment hashes, and `rollback.mjs` under the rollout directory. `node <private-rollout-directory>/rollback.mjs` restores the installed module only and refuses to overwrite a subsequently changed module. Source code remains the trial version; a later rebuild would re-enable it unless the source change is also reverted. Fresh prompt-hook processes load the installed change; already loaded modules may require a reload.

## 1. Snapshot and baseline (U1)

```sh
npm run eval:skill-runtime -- --output <fresh-private-directory-outside-repo>
```

The parent must exist. Inputs default to the local usage events, queries and feedback logs; overrides are available with `--events`, `--queries`, and `--feedback`. This creates private source copies, a turn dataset, an aggregate report and a completion manifest. Existing datasets/runs are never overwritten.

## 2. Freeze a paired development batch (U2)

```sh
npm run eval:skill-runtime:batch -- --run <completed-U1-run> --output <fresh-batch-directory>
npm run eval:skill-runtime:batch -- --batch <batch-directory>
```

Both commands are local-only; the second is a read-only preview. Preparation uses the runtime's merged catalog (or `--library-root <directory>`), freezing current candidate descriptions once for both arms. Missing/ambiguous descriptions, oversized states and ineligible labels are excluded with counts. Historical descriptions are not reconstructed.

Each pair uses the same prompt, candidate names/order/descriptions, model, envelope and threshold. New batches use `bare-check-v2`: preserve the original question and positive criterion, and append only a clarification to the negative criterion that a bare check/review/verify request must not invent a specialized target from description-word overlap. The earlier broader `material-help-v1` batches and registrations remain readable, with their original frozen wording unchanged. Preview identifies the candidate variant and exact changed fields. Arm order alternates by pair; scoring concurrency is one.

The private `batch.json` contains exact outbound bodies plus separate local labels and hashed identities. Bodies contain only the current prompt and candidate metadata—never labels, comments, histories or source paths. Default preview output contains aggregates, the private payload location, endpoint, model, digest, byte/token estimates, cost basis and changed fields. Preparation never writes an approval.

## 3. Register a prospective window (optional)

```sh
npm run eval:skill-runtime:batch -- --register --run <completed-U1-run> --output <fresh-registration-directory>
```

Registration freezes the current/candidate wording and analysis criteria before future predictions. It conservatively marks **all sessions already observed in the snapshot** as development-only, including unlinked raw events/queries with usable session identities. No historical pilot provenance is assumed reliable enough to declare existing sessions untouched.

After the fixed 30-day window ends, take a new U1 snapshot and prepare once:

```sh
npm run eval:skill-runtime:batch -- --run <later-U1-run> --protocol <registration-directory> --output <fresh-batch-directory>
```

Known sessions, unknown session timestamps, and sessions with any observed record outside the window are excluded. Sessions are never split between development and prospective evaluation. Registration allows one batch reservation; it does not permit repeated interim checks with revised snapshots. Failed publication can leave an incomplete batch/reservation requiring review rather than automatic replacement.

Usage logs cannot prove that a session has closed or that all traces were captured. This remains an evidence limitation, not a promise of execution-level completeness. U3 must report insufficient independent labels and uncertainty rather than claiming a win.

## 4. Separate approval and explicit scoring

Review the exact private bodies and preview first. Approval for a prior pilot, the plan, or implementation does **not** authorize this batch. After the user approves the specific batch and estimated budget, create a separate approval JSON with exactly these fields, filled from the preview:

```json
{
  "approved": true,
  "batch_sha256": "<exact-preview-digest>",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "model": "jev-1.13.0",
  "request_count": 0,
  "max_estimated_cost_usd": 0
}
```

The zeros are placeholders, not authorization for a real batch. The count must match exactly and the finite budget must cover the full batch estimate. Estimates use `ceil(request-body bytes / 4)` and the existing published Jev input rate; they are **not a provider-enforced billing cap**. Missing usage is reserved at its estimate; reported usage is used when available. Scoring stops before another request if accounted cost exhausts the budget. Output tokens are currently free at the configured rate.

```sh
npm run eval:skill-runtime:batch -- --batch <batch-directory> --execute --approval <approval.json>
```

Only this mode reads the existing TypeSafe credential and may make external calls. The endpoint/model are pinned, redirects are refused, state-size and timeout limits match the runtime, and there are no automatic retries.

Attempts are durably reserved before sending, and results are written privately. Re-running resumes **only unattempted requests**; it never resends completed or failed requests. A scorer lock prevents concurrent execution. Errors stop the current invocation. A missing result for a reserved attempt, a stale lock, corrupt ledger or incomplete artifacts requires manual review. Do not delete ledger entries to retry: the provider may already have accepted/billed the request.

## 5. Freeze a local paired report (U3)

```sh
npm run eval:skill-runtime:batch -- --batch <batch-directory> --report --output <fresh-private-report-directory>
```

Reporting is local-only and needs no credential or approval file. It creates `report.md` (short explanation), `report.json` (full aggregate analysis), `evidence.json` (private normalized observations and exact ledger hashes), and a completion manifest with artifact hashes and the reporting code revision. The output directory must be fresh, outside the repo, with an existing parent. Inputs and production behavior are not changed.

**Prospective reporting is final:** it reserves the batch's single frozen report and blocks further scoring of that batch, even if scoring was incomplete. A failed publication can leave a reservation requiring manual review. Do not report early, inspect results, resume scoring, and rerun until the candidate wins. Development reports remain explicitly exploratory and can be regenerated into fresh directories.

Quality metrics use only complete valid pairs at the frozen threshold. The report shows TP/FN/TN/FP, class denominators, paired disagreements and excluded pairs; all attempted, invalid, unresolved and pending requests are accounted for separately. Reserved attempts without a valid response count conservatively in the invalid-response rate. Missing feedback is not manufactured into a negative label.

The regression checks retain the frozen limits: positive recall may fall by at most 5 percentage points; invalid-response rate must not rise; mean reported input cost may rise by at most 10%; p95 latency may rise by at most 20%. Missing usage cannot be replaced by an estimate to pass a guardrail. Timing requires all pairs to have comparable measurements and at least 20 pairs (a reporting floor, not a precision guarantee). New scoring attempts record a local execution ID; legacy pairs without it and pairs split across scoring invocations have an unverified latency guardrail. Execution IDs never appear in the public aggregate report.

Uncertainty uses 10,000 deterministic whole-session paired bootstrap resamples, seeded by the batch digest, with a 95% percentile interval. Resamples missing either class are omitted and counted. Session-weighted sensitivity and leave-one-session-out summaries do not expose session identifiers. Prospective comparison requires at least 20 complete-pair sessions and 30 complete-pair labels in each yes/no class; these floors are not a power guarantee. Historical or undersized intervals remain exploratory.

The outcome is one of four messages:

- **Insufficient evidence:** missing, exploratory or undersized evidence, or an unverified required check. Keep the baseline.
- **Regression:** a measured guardrail failure or lower balanced accuracy on this slice. Keep the baseline; do not generalize beyond it.
- **No supported difference:** no established improvement, not proof of equivalence. Keep the baseline.
- **Candidate for review:** prospective floors and all guardrails pass, balanced accuracy improves, and the interval's lower bound is strictly above zero. Human review is still required.

No report authorizes activation. Task benefit, composition quality, session completion and causal next-use improvement remain unproven. Any live rollout needs a separate approval, rollback plan and subsequent measurement.
