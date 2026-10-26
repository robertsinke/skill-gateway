import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSkillRuntimeSnapshot, experimentCodeProvenance, experimentDigest, validateExperimentOutput } from "./skill-runtime-experiment.ts";
import { usageTurnKey } from "./usage-turn-dataset.ts";
import { promptDigest } from "./usage-events.ts";
import { buildSkillRerankRequest, CONSERVATIVE_RERANK_TRIAL, evaluateSkillRerank, SKILL_RERANK_THRESHOLD, type RerankCandidate, type RerankResult, type RerankJudgment } from "./skill-rerank.ts";
import { SKILL_GATE_ENDPOINT, SKILL_GATE_MODEL, SKILL_GATE_MAX_STATE_CHARACTERS, skillGateListCostUsd } from "./skill-gate.ts";
import { readTypeSafeKey } from "./secrets.ts";

type Label = { name: string; relevant: boolean };
export type RerankEvaluationCase = {
  id: string; session: string; candidates: string[]; labels: Label[];
  ranks: { name: string; rank: number }[]; body: string;
};
export type ScoredRerankCase = RerankEvaluationCase & { fits: { name: string; probability: number }[] };
type Batch = {
  schema_version: 1; kind: "skill_rerank_evaluation"; endpoint: string; model: string; judgment?: RerankJudgment;
  source_manifest_sha256: string; cases: RerankEvaluationCase[]; exclusions: Record<string, number>;
  live: ReturnType<typeof liveEvidence>; code: ReturnType<typeof experimentCodeProvenance>;
};
const hash = (value: unknown) => experimentDigest(JSON.stringify(value));
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function record(value: unknown): Record<string, unknown> { requireValue(value && typeof value === "object" && !Array.isArray(value), "Invalid record."); return value as Record<string, unknown>; }
function counts(values: string[]) { const result: Record<string, number> = Object.create(null); for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; }
function write(path: string, value: unknown) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
function read(path: string) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && (stat.mode & 0o077) === 0, "Expected a private regular file.");
  return readFileSync(path);
}
function directory(path: string) { const stat = lstatSync(path); requireValue(stat.isDirectory() && (stat.mode & 0o077) === 0, "Expected a private directory."); }
function validFits(value: unknown, candidates: string[]): value is { name: string; probability: number }[] {
  if (!Array.isArray(value) || value.length !== candidates.length) return false;
  const names = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item.name !== "string" || !candidates.includes(item.name) || names.has(item.name)
      || typeof item.probability !== "number" || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1) return false;
    names.add(item.name); return true;
  });
}

/** Exact identity joins only. Control arm labels and treatment labels are not assumed comparable. */
function liveEvidence(snapshot: ReturnType<typeof loadSkillRuntimeSnapshot>) {
  const events = snapshot.events.filter((row) => row.event_type === "skill_rerank_experiment" || row.event_type === "skill_rerank_shadow");
  const byTurn = new Map<string, typeof events>();
  const gateByTurn = new Map<string, typeof events>();
  for (const event of snapshot.events.filter((row) => row.event_type === "gate_decision")) {
    const key = usageTurnKey(event); if (key) gateByTurn.set(key, [...(gateByTurn.get(key) ?? []), event]);
  }
  let unlinked = 0;
  for (const event of events) { const key = usageTurnKey(event); if (!key) unlinked++; else byTurn.set(key, [...(byTurn.get(key) ?? []), event]); }
  const cached: ScoredRerankCase[] = [];
  const cachedByPolicy = new Map<string, ScoredRerankCase[]>();
  const policy = (event: Record<string, unknown>) => event.rerank_policy === CONSERVATIVE_RERANK_TRIAL.id ? CONSERVATIVE_RERANK_TRIAL.id : "unrecorded";
  const exclusions: string[] = [];
  let linked = 0;
  const arms: string[] = [];
  for (const turn of snapshot.analysis.dataset.rows) {
    const key = usageTurnKey(turn)!;
    for (const gate of gateByTurn.get(key) ?? []) arms.push(gate.experiment_arm === "control" ? "control" : gate.experiment_arm === "treatment" ? "treatment" : "not_recorded");
    const matches = byTurn.get(key);
    if (!matches) continue;
    linked += matches.length;
    if (matches.length !== 1) { exclusions.push("multiple_reranks"); continue; }
    const event = matches[0]!;
    const gates = gateByTurn.get(key);
    if (gates?.length !== 1 || gates[0]!.gate_status !== "pass") { exclusions.push("gate_not_passed"); continue; }
    const provenance = [event, gates[0]!];
    const legacy = provenance.every((row) => row.rerank_policy == null && row.rerank_judgment == null && row.rerank_threshold == null);
    const current = provenance.every((row) => row.rerank_policy === CONSERVATIVE_RERANK_TRIAL.id
      && row.rerank_judgment === CONSERVATIVE_RERANK_TRIAL.judgment && row.rerank_threshold === CONSERVATIVE_RERANK_TRIAL.threshold);
    if (!legacy && !current) { exclusions.push("policy_mismatch"); continue; }
    if (event.event_type === "skill_rerank_shadow" && (event.experiment_arm != null || gates[0]!.experiment_arm != null)) {
      exclusions.push("arm_mismatch"); continue;
    }
    if (event.event_type === "skill_rerank_experiment"
      && (event.experiment_arm !== "treatment" || gates?.length !== 1 || gates[0]!.experiment_arm !== "treatment")) {
      exclusions.push("arm_mismatch"); continue;
    }
    if (turn.query_match_status !== "matched_hash" || !turn.query || event.prompt_sha256 !== promptDigest(turn.query.trim())) { exclusions.push("hash_not_verified"); continue; }
    const names = event.candidate_names;
    if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string") || new Set(names).size !== names.length
      || turn.gate_decisions.length !== 1 || JSON.stringify(names) !== JSON.stringify(turn.gate_decisions[0]!.candidate_names)) { exclusions.push("candidate_mismatch"); continue; }
    const selected = event.selected_names;
    if (event.status !== "ok" || !validFits(event.fits, names) || !Array.isArray(selected)
      || !selected.every((name): name is string => typeof name === "string" && names.includes(name))
      || new Set(selected).size !== selected.length) { exclusions.push("invalid_response"); continue; }
    const labels = (turn.feedback?.user_skill_feedback ?? []).filter((item) => item.relevance !== "unsure" && names.includes(item.skill_name) && turn.injected_skill_names.includes(item.skill_name))
      .map((item) => ({ name: item.skill_name, relevant: item.relevance === "relevant" }));
    if (!labels.length) { exclusions.push("no_explicit_labels"); continue; }
    const observation = { id: hash(key), session: hash([turn.user_id, turn.session_id]), candidates: names, labels, ranks: [], body: "",
      fits: event.fits.map((fit) => ({ name: fit.name, probability: selected.includes(fit.name) ? 1 : 0 })) };
    cached.push(observation);
    const version = policy(event);
    cachedByPolicy.set(version, [...(cachedByPolicy.get(version) ?? []), observation]);
  }
  return { events: events.length, exact_linked_events: linked, unlinked_identity_events: unlinked,
    events_without_dataset_turn: events.length - linked - unlinked, arm_gate_counts: counts(arms),
    exclusions: counts(exclusions), labeled_turns: cached.length,
    policy_event_counts: counts(events.map(policy)),
    cached_quality: selectionMetrics(cached, (row) => row.fits.filter((fit) => fit.probability >= 0.5).map((fit) => fit.name)),
    cached_quality_by_policy: Object.fromEntries([...cachedByPolicy].map(([version, rows]) => [version,
      selectionMetrics(rows, (row) => row.fits.filter((fit) => fit.probability >= 0.5).map((fit) => fit.name))])),
    warning: "Live labels are selective after filtering; cached fits are not a reconstruction of historical descriptions/model wording. These counts are not a causal arm comparison." };
}

export function prepareRerankEvaluation(runPath: string, outputPath: string, catalog: RerankCandidate[], judgment: RerankJudgment = "current-v1") {
  const snapshot = loadSkillRuntimeSnapshot(runPath);
  const descriptions = new Map<string, string>(), ambiguous = new Set<string>();
  for (const item of catalog) { if (descriptions.has(item.name)) ambiguous.add(item.name); descriptions.set(item.name, item.description); }
  const rawGates = new Map<string, typeof snapshot.events>();
  for (const event of snapshot.events.filter((row) => row.event_type === "gate_decision")) {
    const key = usageTurnKey(event); if (key) rawGates.set(key, [...(rawGates.get(key) ?? []), event]);
  }
  const exclusions: Record<string, number> = Object.create(null);
  const exclude = (name: string) => { exclusions[name] = (exclusions[name] ?? 0) + 1; };
  const cases: RerankEvaluationCase[] = [];
  for (const turn of snapshot.analysis.dataset.rows) {
    if (!(turn.feedback?.user_skill_feedback ?? []).some((item) => item.relevance !== "unsure")) continue;
    if (turn.query_match_status !== "matched_hash" || !turn.query?.trim()) { exclude("query_not_hash_linked"); continue; }
    const raw = rawGates.get(usageTurnKey(turn)!);
    if (turn.gate_decisions.length !== 1 || raw?.length !== 1) { exclude("gate_count_not_one"); continue; }
    const names = turn.gate_decisions[0]!.candidate_names;
    if (!names.length || names.length > 5 || !Array.isArray(raw[0]!.candidate_names)
      || raw[0]!.candidate_names.length !== names.length || !names.every((name) => name.trim() === name)) { exclude("ambiguous_candidates"); continue; }
    const labels = turn.feedback!.user_skill_feedback.filter((item) => item.relevance !== "unsure");
    if (labels.some((item) => !names.includes(item.skill_name) || !turn.injected_skill_names.includes(item.skill_name))) { exclude("unobserved_labels"); continue; }
    if (names.some((name) => ambiguous.has(name) || !descriptions.get(name)?.trim())) { exclude("missing_or_ambiguous_description"); continue; }
    const body = buildSkillRerankRequest(turn.query, names.map((name) => ({ name, description: descriptions.get(name)! })), judgment);
    if (JSON.stringify(body.state).length > SKILL_GATE_MAX_STATE_CHARACTERS) { exclude("state_too_large"); continue; }
    const rankings = turn.gate_decisions[0]!.candidate_rankings;
    const nameCounts = counts(rankings.map((item) => item.name)), rankCounts = counts(rankings.map((item) => String(item.rank)));
    const ranks = rankings.flatMap((item) => names.includes(item.name) && item.rank !== null && Number.isSafeInteger(item.rank) && item.rank > 0
      && nameCounts[item.name] === 1 && rankCounts[String(item.rank)] === 1 ? [{ name: item.name, rank: item.rank }] : []);
    cases.push({ id: String(cases.length + 1).padStart(6, "0"), session: hash([turn.user_id, turn.session_id]), candidates: names,
      labels: labels.map((item) => ({ name: item.skill_name, relevant: item.relevance === "relevant" })), ranks, body: JSON.stringify(body) });
  }
  const batch: Batch = { schema_version: 1, kind: "skill_rerank_evaluation", source_manifest_sha256: snapshot.manifest_sha256, judgment,
    endpoint: SKILL_GATE_ENDPOINT, model: SKILL_GATE_MODEL, cases, exclusions, live: liveEvidence(snapshot), code: experimentCodeProvenance() };
  const output = resolve(outputPath); validateExperimentOutput(output); mkdirSync(output, { mode: 0o700 });
  mkdirSync(join(output, "attempts"), { mode: 0o700 }); mkdirSync(join(output, "results"), { mode: 0o700 });
  write(join(output, "batch.json"), batch);
  write(join(output, "manifest.json"), { schema_version: 1, status: "complete", batch_sha256: experimentDigest(read(join(output, "batch.json"))) });
  return previewRerankEvaluation(output);
}
function loadBatch(path: string) {
  directory(path); directory(join(path, "attempts")); directory(join(path, "results"));
  const bytes = read(join(path, "batch.json")), manifest = record(JSON.parse(read(join(path, "manifest.json")).toString()));
  requireValue(manifest.status === "complete" && manifest.batch_sha256 === experimentDigest(bytes), "Batch hash mismatch.");
  const batch = JSON.parse(bytes.toString()) as Batch;
  requireValue(batch.schema_version === 1 && batch.kind === "skill_rerank_evaluation" && batch.endpoint === SKILL_GATE_ENDPOINT && batch.model === SKILL_GATE_MODEL
    && Array.isArray(batch.cases) && (batch.judgment === undefined || batch.judgment === "current-v1" || batch.judgment === "relevance-v2"), "Invalid rerank batch.");
  for (const [index, row] of batch.cases.entries()) {
    requireValue(row.id === String(index + 1).padStart(6, "0") && typeof row.session === "string" && /^[a-f0-9]{64}$/.test(row.session), "Invalid case identity.");
    const body = JSON.parse(row.body);
    requireValue(typeof body.state?.prompt === "string" && Array.isArray(body.state.candidates) && body.state.candidates.length > 0 && body.state.candidates.length <= 5
      && body.state.candidates.every((item: RerankCandidate) => item && Object.keys(item).sort().join(",") === "description,name"
        && typeof item.name === "string" && item.name.trim() && typeof item.description === "string" && item.description.trim()), "Invalid case input.");
    requireValue(JSON.stringify(body.state.candidates.map((item: RerankCandidate) => item.name)) === JSON.stringify(row.candidates)
      && new Set(row.candidates).size === row.candidates.length && row.body === JSON.stringify(buildSkillRerankRequest(body.state.prompt, body.state.candidates, batch.judgment))
      && JSON.stringify(body.state).length <= SKILL_GATE_MAX_STATE_CHARACTERS, "Frozen rerank payload differs from the current builder.");
    requireValue(Array.isArray(row.labels) && row.labels.length > 0 && new Set(row.labels.map((item) => item.name)).size === row.labels.length
      && row.labels.every((item) => row.candidates.includes(item.name) && typeof item.relevant === "boolean"), "Invalid labels.");
  }
  const expected = new Set(batch.cases.map((row) => row.id + ".json"));
  requireValue(["attempts", "results"].every((name) => readdirSync(join(path, name)).every((file) => expected.has(file))), "Unknown ledger entries.");
  return { batch, digest: experimentDigest(bytes) };
}
function estimate(batch: Batch) { return skillGateListCostUsd(batch.cases.reduce((total, row) => total + Math.ceil(Buffer.byteLength(row.body) / 4), 0))!; }
function saved(path: string, row: RerankEvaluationCase, batchHash: string) {
  const attemptPath = join(path, "attempts", row.id + ".json"), resultPath = join(path, "results", row.id + ".json");
  if (!existsSync(attemptPath)) { requireValue(!existsSync(resultPath), "Result without attempt."); return null; }
  const attempt = read(attemptPath), info = record(JSON.parse(attempt.toString()));
  requireValue(info.batch_sha256 === batchHash && info.body_sha256 === experimentDigest(row.body), "Attempt mismatch.");
  requireValue(existsSync(resultPath), "Unresolved attempt requires manual review; do not resend it.");
  const result = record(JSON.parse(read(resultPath).toString()));
  requireValue(result.attempt_sha256 === experimentDigest(attempt), "Result mismatch.");
  const response = result.response as RerankResult;
  requireValue(response && (response.status === "ok" || response.status === "error") && typeof response.request_attempted === "boolean", "Invalid saved response.");
  if (response.status === "ok") requireValue(validFits(response.fits, row.candidates), "Invalid saved fits.");
  requireValue(response.input_tokens === undefined || (Number.isSafeInteger(response.input_tokens) && response.input_tokens >= 0), "Invalid saved usage.");
  requireValue(typeof response.latency_ms === "number" && Number.isFinite(response.latency_ms) && response.latency_ms >= 0, "Invalid saved latency.");
  return response;
}
export function previewRerankEvaluation(path: string) {
  const { batch, digest } = loadBatch(path);
  return { batch_sha256: digest, endpoint: batch.endpoint, model: batch.model, requests: batch.cases.length,
    labels: { relevant: batch.cases.reduce((n, row) => n + row.labels.filter((label) => label.relevant).length, 0),
      not_relevant: batch.cases.reduce((n, row) => n + row.labels.filter((label) => !label.relevant).length, 0) },
    sessions: new Set(batch.cases.map((row) => row.session)).size, judgment: batch.judgment ?? "current-v1",
    estimated_cost_usd: estimate(batch), exclusions: batch.exclusions, live: batch.live,
    external_calls: 0, notice: "Development data; current descriptions; labels and identities remain local. Only --execute sends frozen prompt/candidate metadata." };
}
export async function scoreRerankEvaluation(path: string, options: { maxCostUsd: number; apiKey?: string; fetcher?: typeof fetch }) {
  const { batch, digest } = loadBatch(path);
  requireValue(batch.cases.length > 0, "Empty rerank batch.");
  requireValue(Number.isFinite(options.maxCostUsd) && options.maxCostUsd >= estimate(batch), "Budget does not cover the estimated batch.");
  const apiKey = options.apiKey ?? readTypeSafeKey(); requireValue(apiKey, "Credential unavailable.");
  const lock = join(path, "evaluation.lock"); write(lock, { batch_sha256: digest, max_cost_usd: options.maxCostUsd });
  let calls = 0, cost = 0;
  try {
    // Verify the whole ledger before sending anything, including ambiguous interrupted attempts.
    const existing = new Map(batch.cases.map((row) => [row.id, saved(path, row, digest)]));
    for (const row of batch.cases) {
      const response = existing.get(row.id);
      if (response?.request_attempted) cost += skillGateListCostUsd(response.input_tokens ?? Math.ceil(Buffer.byteLength(row.body) / 4))!;
    }
    for (const row of batch.cases) {
      if (existing.get(row.id)) continue;
      requireValue(cost + skillGateListCostUsd(Math.ceil(Buffer.byteLength(row.body) / 4))! <= options.maxCostUsd + 1e-12, "Accounted cost exhausted budget.");
      const attemptPath = join(path, "attempts", row.id + ".json");
      write(attemptPath, { batch_sha256: digest, body_sha256: experimentDigest(row.body), started_at: new Date().toISOString() });
      const dirFd = openSync(join(path, "attempts"), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      const body = JSON.parse(row.body);
      const response = await evaluateSkillRerank(body.state.prompt, body.state.candidates, { apiKey, judgment: batch.judgment,
        fetcher: (url, init) => {
          requireValue(url === SKILL_GATE_ENDPOINT && init?.body === row.body, "Outbound request differs from frozen batch.");
          return (options.fetcher ?? fetch)(url, { ...init, redirect: "error" });
        } });
      if (response.request_attempted) { calls++; cost += skillGateListCostUsd(response.input_tokens ?? response.estimated_input_tokens)!; }
      write(join(path, "results", row.id + ".json"), { attempt_sha256: experimentDigest(read(attemptPath)), response });
      if (response.status === "error") break;
    }
    return { batch_sha256: digest, external_calls: calls, accounted_cost_usd: cost };
  } finally { unlinkSync(lock); }
}

const rate = (n: number, d: number) => d ? n / d : null;
export function selectionMetrics<T extends RerankEvaluationCase>(rows: T[], select: (row: T) => string[]) {
  let tp = 0, fn = 0, fp = 0, tn = 0, unknownSelected = 0, selected = 0, positiveTurns = 0, missedPositiveTurns = 0, partiallyMissedTurns = 0, multiPositiveTurns = 0;
  for (const row of rows) {
    const keep = new Set(select(row)); selected += keep.size;
    const known = new Set(row.labels.map((item) => item.name));
    unknownSelected += [...keep].filter((name) => !known.has(name)).length;
    const positives = row.labels.filter((label) => label.relevant);
    if (positives.length) { positiveTurns++; if (!positives.some((label) => keep.has(label.name))) missedPositiveTurns++; if (positives.some((label) => !keep.has(label.name))) partiallyMissedTurns++; }
    if (positives.length > 1) multiPositiveTurns++;
    for (const label of row.labels) if (label.relevant) { if (keep.has(label.name)) tp++; else fn++; } else { if (keep.has(label.name)) fp++; else tn++; }
  }
  return { turns: rows.length, relevant: tp + fn, not_relevant: tn + fp, tp, fn, fp, tn,
    relevant_retention: rate(tp, tp + fn), labeled_selection_precision: rate(tp, tp + fp), irrelevant_removal: rate(tn, tn + fp),
    total_selected_candidates: selected, selected_without_labels: unknownSelected,
    positive_turns: positiveTurns, fully_missed_positive_turns: missedPositiveTurns, partially_missed_positive_turns: partiallyMissedTurns, multi_relevant_turns: multiPositiveTurns };
}
function atThreshold(rows: ScoredRerankCase[], threshold: number) {
  return selectionMetrics(rows, (row) => row.fits.filter((fit) => fit.probability >= threshold).map((fit) => fit.name));
}
/** Training labels only: maximize removal subject to 95% positive retention, then preserve more positives. */
export function chooseRerankThreshold(training: ScoredRerankCase[]): number | null {
  const labels = training.flatMap((row) => row.labels);
  if (!labels.some((label) => label.relevant) || !labels.some((label) => !label.relevant)) return null;
  const candidates = [...new Set([0, SKILL_RERANK_THRESHOLD, 1, ...training.flatMap((row) => row.fits.map((fit) => fit.probability))])].sort((a, b) => a - b);
  let best: { threshold: number; fp: number; tp: number } | null = null;
  for (const threshold of candidates) {
    const metric = atThreshold(training, threshold);
    if (metric.relevant_retention! < 0.95 - 1e-12) continue;
    if (!best || metric.fp < best.fp || (metric.fp === best.fp && metric.tp > best.tp)) best = { threshold, fp: metric.fp, tp: metric.tp };
  }
  return best?.threshold ?? null;
}
export function analyzeRerankScores(rows: ScoredRerankCase[]) {
  const sessions = [...new Set(rows.map((row) => row.session))].sort();
  const cv: ScoredRerankCase[] = [], thresholds: number[] = [];
  let skippedSessions = 0;
  for (const session of sessions) {
    const threshold = chooseRerankThreshold(rows.filter((row) => row.session !== session));
    if (threshold === null) { skippedSessions++; continue; }
    thresholds.push(threshold);
    for (const row of rows.filter((row) => row.session === session)) cv.push({ ...row, fits: row.fits.map((fit) => ({ name: fit.name, probability: fit.probability >= threshold ? 1 : 0 })) });
  }
  const diagnostics = new Map<string, { name: string; relevant: number; not_relevant: number; selected_relevant: number; selected_not_relevant: number }>();
  for (const row of rows) for (const label of row.labels) {
    let item = diagnostics.get(label.name);
    if (!item) { item = { name: label.name, relevant: 0, not_relevant: 0, selected_relevant: 0, selected_not_relevant: 0 }; diagnostics.set(label.name, item); }
    const selected = row.fits.find((fit) => fit.name === label.name)!.probability >= SKILL_RERANK_THRESHOLD;
    if (label.relevant) { item.relevant++; if (selected) item.selected_relevant++; }
    else { item.not_relevant++; if (selected) item.selected_not_relevant++; }
  }
  const rank = (k: number) => {
    // Missing ranks are excluded explicitly, never inferred from candidate array order.
    const ranked = rows.map((row) => ({ ...row, labels: row.labels.filter((label) => row.ranks.some((item) => item.name === label.name)) }));
    return { ...selectionMetrics(ranked, (row) => row.ranks.filter((item) => item.rank <= k).map((item) => item.name)),
      excluded_missing_rank_labels: rows.reduce((n, row) => n + row.labels.filter((label) => !row.ranks.some((item) => item.name === label.name)).length, 0) };
  };
  return { report: { scored_turns: rows.length, scored_sessions: sessions.length,
    keep_all: selectionMetrics(rows, (row) => row.candidates), top_one: rank(1), top_three: rank(3),
    current_reranker_0_5: atThreshold(rows, SKILL_RERANK_THRESHOLD),
    development_thresholds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((threshold) => ({ threshold, ...atThreshold(rows, threshold) })),
    session_held_out_calibration: { folds: thresholds.length, skipped_sessions: skippedSessions, training_retention_target: 0.95,
      threshold_counts: counts(thresholds.map(String)), keep_all_on_same_folds: selectionMetrics(cv, (row) => row.candidates),
      current_on_same_folds: atThreshold(rows.filter((row) => cv.some((held) => held.id === row.id)), SKILL_RERANK_THRESHOLD),
      calibrated: atThreshold(cv, 0.5) },
    proposed_development_threshold: chooseRerankThreshold(rows),
    production_changed: false,
    limitations: ["Explicit relevance labels cover exposed skills only; unlabeled candidates and censored rejections are unknown.",
      "Offline replay uses frozen current descriptions and the current model, not exact historical request reconstruction.",
      "Thresholds are exploratory. Whole-session holdout prevents training-label leakage but does not create untouched prospective evidence.",
      "Skill retention and filtering are not task-benefit or composition-quality measurements. No blacklist, description edit or deployment is authorized by this report."] },
    privateSkillDiagnostics: [...diagnostics.values()].sort((a, b) => b.selected_not_relevant - a.selected_not_relevant) };
}
export function reportRerankEvaluation(path: string, outputPath: string) {
  const { batch, digest } = loadBatch(path);
  const lock = join(path, "evaluation.lock"); write(lock, { batch_sha256: digest });
  try {
    const scored: ScoredRerankCase[] = [], failed: RerankEvaluationCase[] = [];
    let errors = 0, pending = 0; const latencies: number[] = []; let cost = 0, missingUsage = 0;
    const evidence: { id: string; result_sha256: string | null }[] = [];
    for (const row of batch.cases) {
      const response = saved(path, row, digest);
      evidence.push({ id: row.id, result_sha256: response ? experimentDigest(read(join(path, "results", row.id + ".json"))) : null });
      if (!response) { pending++; continue; }
      if (response.request_attempted) {
        latencies.push(response.latency_ms);
        if (response.input_tokens === undefined) missingUsage++; else cost += skillGateListCostUsd(response.input_tokens)!;
      }
      if (response.status !== "ok") { errors++; failed.push(row); continue; }
      scored.push({ ...row, fits: response.fits });
    }
    const { report, privateSkillDiagnostics } = analyzeRerankScores(scored);
    latencies.sort((a, b) => a - b);
    const full = { schema_version: 1, batch_sha256: digest, source_manifest_sha256: batch.source_manifest_sha256, judgment: batch.judgment ?? "current-v1",
      coverage: { prepared_turns: batch.cases.length, scored_turns: scored.length, errors, pending, preparation_exclusions: batch.exclusions,
        prepared_keep_all: selectionMetrics(batch.cases, (row) => row.candidates) },
      live: batch.live, analysis: report,
      completed_policy_with_error_fallback: selectionMetrics([...scored, ...failed], (row) => {
        const success = scored.find((item) => item.id === row.id);
        return success ? success.fits.filter((fit) => fit.probability >= SKILL_RERANK_THRESHOLD).map((fit) => fit.name) : row.candidates;
      }),
      request_metrics: { reported_input_cost_usd: cost, missing_usage: missingUsage,
        latency_p95_ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null } };
    const output = resolve(outputPath); validateExperimentOutput(output); mkdirSync(output, { mode: 0o700 });
    write(join(output, "report.json"), full); write(join(output, "skill-diagnostics.json"), privateSkillDiagnostics);
    write(join(output, "evidence.json"), { batch_sha256: digest, results: evidence });
    write(join(output, "manifest.json.tmp"), { status: "complete", code: experimentCodeProvenance(), artifacts: Object.fromEntries(["report.json", "skill-diagnostics.json", "evidence.json"].map((name) => [name, experimentDigest(read(join(output, name)))])) });
    renameSync(join(output, "manifest.json.tmp"), join(output, "manifest.json"));
    return full;
  } finally { unlinkSync(lock); }
}
