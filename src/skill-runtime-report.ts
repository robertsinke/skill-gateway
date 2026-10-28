import { SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS, skillGateListCostUsd } from "./skill-gate.ts";

export type ReportCriteria = {
  threshold: number; minimum_sessions: number; minimum_yes: number; minimum_no: number;
  positive_recall_max_drop: number; input_cost_max_increase: number; p95_latency_max_increase: number;
  invalid_response_rate_must_not_increase: boolean; balanced_accuracy_must_improve: boolean;
  bootstrap_session_resamples: number; bootstrap_interval: number;
};
export type ReportObservation = {
  attempted: boolean;
  result: {
    status: "pass" | "reject" | "error"; probability: number | null;
    request_attempted: boolean; input_tokens: number | null; latency_ms: number | null;
    execution_id: string | null;
  } | null;
};
export type SkillRuntimeReportInput = {
  batch_sha256: string; source_manifest_sha256: string;
  cohort: "development" | "prospective"; criteria: ReportCriteria; preparation_exclusions: Record<string, number>;
  pairs: { session: string; label: "yes" | "no"; baseline: ReportObservation; candidate: ReportObservation }[];
};
type Counts = { tp: number; fn: number; tn: number; fp: number };
type Check = { status: "pass" | "fail" | "unverified"; reason: string };
const ARMS = ["baseline", "candidate"] as const;
// At least one observation per 5% tail step; not a precision guarantee.
const MINIMUM_LATENCY_PAIRS = 20;
const empty = (): Counts => ({ tp: 0, fn: 0, tn: 0, fp: 0 });
const rate = (a: number, b: number): number | null => b ? a / b : null;
function metrics(counts: Counts) {
  const yes = counts.tp + counts.fn, no = counts.tn + counts.fp;
  const recall = rate(counts.tp, yes), rejection = rate(counts.tn, no);
  return { ...counts, yes, no, total: yes + no, positive_recall: recall, negative_rejection_rate: rejection,
    false_negative_rate: rate(counts.fn, yes), false_positive_rate: rate(counts.fp, no),
    accuracy: rate(counts.tp + counts.tn, yes + no),
    balanced_accuracy: recall === null || rejection === null ? null : (recall + rejection) / 2 };
}
function add(counts: Counts, yes: boolean, pass: boolean): void {
  if (yes) { if (pass) counts.tp++; else counts.fn++; }
  else { if (pass) counts.fp++; else counts.tn++; }
}
function merge(target: Counts, source: Counts): void {
  target.tp += source.tp; target.fn += source.fn; target.tn += source.tn; target.fp += source.fp;
}
function difference(baseline: Counts, candidate: Counts): number | null {
  const a = metrics(baseline).balanced_accuracy, b = metrics(candidate).balanced_accuracy;
  return a === null || b === null ? null : b - a;
}
function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, mean: rate(sorted.reduce((a, b) => a + b, 0), sorted.length),
    min: sorted[0] ?? null, median: quantile(sorted, 0.5), max: sorted.at(-1) ?? null };
}
function random(seed: number) {
  let value = seed;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Cluster = { baseline: Counts; candidate: Counts };
function bootstrap(clusters: Cluster[], input: SkillRuntimeReportInput) {
  const seed = parseInt(input.batch_sha256.slice(0, 8), 16) >>> 0;
  const rng = random(seed);
  const values: number[] = [];
  let omitted = 0;
  const possible = clusters.length >= 2;
  const iterations = possible ? input.criteria.bootstrap_session_resamples : 0;
  for (let i = 0; i < iterations; i++) {
    const baseline = empty(), candidate = empty();
    // Resample entire sessions with replacement, keeping both arms paired.
    for (let j = 0; j < clusters.length; j++) {
      const cluster = clusters[Math.floor(rng() * clusters.length)]!;
      merge(baseline, cluster.baseline); merge(candidate, cluster.candidate);
    }
    const delta = difference(baseline, candidate);
    if (delta === null) omitted++; else values.push(delta);
  }
  values.sort((a, b) => a - b);
  const tail = (1 - input.criteria.bootstrap_interval) / 2;
  return { method: "paired_session_cluster_percentile_bootstrap", seed, requested_resamples: input.criteria.bootstrap_session_resamples,
    attempted_resamples: iterations, valid_resamples: values.length, omitted_class_missing_resamples: omitted,
    confidence_level: input.criteria.bootstrap_interval,
    interval: values.length ? { lower: quantile(values, tail)!, upper: quantile(values, 1 - tail)! } : null,
    status: possible ? values.length ? "computed" : "no_class_complete_resamples" : "insufficient_sessions" };
}

function valid(observation: ReportObservation): boolean {
  return observation.result !== null && observation.result.status !== "error" && observation.result.probability !== null;
}
function armCoverage(observations: ReportObservation[]) {
  const attempted = observations.filter((item) => item.attempted).length;
  const completed = observations.filter((item) => item.result !== null).length;
  const errors = observations.filter((item) => item.result?.status === "error").length;
  const ambiguous = attempted - completed;
  return { planned: observations.length, attempted_reservations: attempted, completed, valid: observations.filter(valid).length,
    errors, ambiguous, pending: observations.length - attempted,
    confirmed_transmitted: observations.filter((item) => item.result?.request_attempted === true).length,
    local_failures: observations.filter((item) => item.result?.request_attempted === false).length,
    // Conservative rate on all reserved attempts: unresolved attempts count as invalid.
    invalid_or_unresolved: errors + ambiguous, invalid_response_rate: rate(errors + ambiguous, attempted) };
}
function costSummary(observations: ReportObservation[]) {
  const tokens = observations.flatMap((item) => item.result?.request_attempted && item.result.input_tokens !== null ? [item.result.input_tokens] : []);
  return { planned: observations.length, reported_usage_count: tokens.length,
    missing_usage_count: observations.length - tokens.length,
    mean_reported_input_tokens: rate(tokens.reduce((a, b) => a + b, 0), tokens.length),
    mean_reported_input_cost_usd: rate(tokens.reduce((sum, value) => sum + skillGateListCostUsd(value)!, 0), tokens.length) };
}
function checkLimit(baseline: number | null, candidate: number | null, limit: number, enough: boolean, reason: string): Check {
  if (!enough || baseline === null || candidate === null) return { status: "unverified", reason };
  return candidate <= baseline * (1 + limit) + 1e-12
    ? { status: "pass", reason: "Within the frozen relative-increase limit." }
    : { status: "fail", reason: "Exceeds the frozen relative-increase limit." };
}

/** Pure aggregate analysis. Session keys are used internally, never returned. */
export function analyzePairedSkillRuntime(input: SkillRuntimeReportInput) {
  const { criteria } = input;
  const counts = { baseline: empty(), candidate: empty() };
  const clusters = new Map<string, Cluster>();
  const disagreements = { baseline_pass_candidate_reject: 0, baseline_reject_candidate_pass: 0,
    baseline_only_correct: 0, candidate_only_correct: 0, both_correct: 0, both_wrong: 0 };
  let complete = 0;
  const timing = { baseline: [] as number[], candidate: [] as number[] };
  let comparableTimingPairs = 0;
  for (const pair of input.pairs) {
    const a = pair.baseline.result, b = pair.candidate.result;
    if (a && b && a.request_attempted && b.request_attempted && a.latency_ms !== null && b.latency_ms !== null
      && a.execution_id !== null && a.execution_id === b.execution_id) {
      comparableTimingPairs++;
      timing.baseline.push(a.latency_ms); timing.candidate.push(b.latency_ms);
    }
    if (!valid(pair.baseline) || !valid(pair.candidate)) continue;
    complete++;
    const yes = pair.label === "yes";
    const passA = a!.probability! >= criteria.threshold, passB = b!.probability! >= criteria.threshold;
    let cluster = clusters.get(pair.session);
    if (!cluster) { cluster = { baseline: empty(), candidate: empty() }; clusters.set(pair.session, cluster); }
    add(counts.baseline, yes, passA); add(counts.candidate, yes, passB);
    add(cluster.baseline, yes, passA); add(cluster.candidate, yes, passB);
    if (passA && !passB) disagreements.baseline_pass_candidate_reject++;
    if (!passA && passB) disagreements.baseline_reject_candidate_pass++;
    if (passA === yes && passB === yes) disagreements.both_correct++;
    else if (passA !== yes && passB !== yes) disagreements.both_wrong++;
    else if (passA === yes) disagreements.baseline_only_correct++;
    else disagreements.candidate_only_correct++;
  }
  const baseline = metrics(counts.baseline), candidate = metrics(counts.candidate);
  const delta = difference(counts.baseline, counts.candidate);
  const recallDelta = baseline.positive_recall === null || candidate.positive_recall === null ? null : candidate.positive_recall - baseline.positive_recall;
  const coverage = {
    baseline: armCoverage(input.pairs.map((pair) => pair.baseline)),
    candidate: armCoverage(input.pairs.map((pair) => pair.candidate)),
  };
  const costs = { baseline: costSummary(input.pairs.map((pair) => pair.baseline)), candidate: costSummary(input.pairs.map((pair) => pair.candidate)) };
  const settled = input.pairs.length > 0 && ARMS.every((arm) => coverage[arm].completed === input.pairs.length);
  const p95 = (arm: "baseline" | "candidate") => {
    const sorted = [...timing[arm]].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null;
  };
  const latency = { comparable_pairs: comparableTimingPairs, minimum_pairs: MINIMUM_LATENCY_PAIRS,
    baseline_p95_ms: p95("baseline"), candidate_p95_ms: p95("candidate"),
    method: "nearest_rank_p95_same_execution_pairs", legacy_or_resumed_pairs_are_unverified: true };
  const invalidA = coverage.baseline.invalid_response_rate, invalidB = coverage.candidate.invalid_response_rate;
  const guardrails = {
    positive_recall: recallDelta === null ? { status: "unverified", reason: "No complete paired positive labels." } as Check
      : recallDelta >= -criteria.positive_recall_max_drop - 1e-12
        ? { status: "pass", reason: "Within the frozen positive-recall drop limit." } as Check
        : { status: "fail", reason: "Positive recall dropped beyond the frozen limit." } as Check,
    invalid_response_rate: !settled || invalidA === null || invalidB === null
      ? { status: "unverified", reason: "Unfinished scoring or no attempted responses." } as Check
      : invalidB <= invalidA
        ? { status: "pass", reason: "Invalid-response rate did not increase on all reserved attempts." } as Check
        : { status: "fail", reason: "Invalid-response rate increased on all reserved attempts." } as Check,
    mean_input_cost: checkLimit(costs.baseline.mean_reported_input_cost_usd, costs.candidate.mean_reported_input_cost_usd,
      criteria.input_cost_max_increase, settled && costs.baseline.missing_usage_count === 0 && costs.candidate.missing_usage_count === 0,
      "Reported usage is missing; estimates cannot pass the cost guardrail."),
    p95_latency: checkLimit(latency.baseline_p95_ms, latency.candidate_p95_ms, criteria.p95_latency_max_increase,
      settled && comparableTimingPairs === input.pairs.length && comparableTimingPairs >= MINIMUM_LATENCY_PAIRS,
      "Need at least 20 timing pairs, complete timings, and the same scoring execution for each pair."),
  };
  const clusterList = [...clusters.values()];
  const sessionAccuracyDeltas = clusterList.map((cluster) => metrics(cluster.candidate).accuracy! - metrics(cluster.baseline).accuracy!);
  const sessionBalancedDeltas = clusterList.flatMap((cluster) => {
    const value = difference(cluster.baseline, cluster.candidate); return value === null ? [] : [value];
  });
  const leaveOneOut = clusterList.length < 2 ? [] : clusterList.flatMap((excluded) => {
    const a = { ...counts.baseline }, b = { ...counts.candidate };
    for (const key of ["tp", "fn", "tn", "fp"] as const) { a[key] -= excluded.baseline[key]; b[key] -= excluded.candidate[key]; }
    const value = difference(a, b); return value === null ? [] : [value];
  });
  const uncertainty = bootstrap(clusterList, input);
  const floors = { sessions: clusters.size >= criteria.minimum_sessions, yes: baseline.yes >= criteria.minimum_yes, no: baseline.no >= criteria.minimum_no };
  const minimumsMet = Object.values(floors).every(Boolean);
  const reasons: string[] = [];
  if (!settled) reasons.push("scoring_incomplete");
  if (complete === 0) reasons.push("no_complete_valid_pairs");
  if (delta === null) reasons.push("both_label_classes_required");
  if (input.cohort === "development") reasons.push("development_evidence_only");
  if (!minimumsMet) reasons.push("independent_evidence_floors_not_met");
  const failed = Object.entries(guardrails).filter(([, value]) => value.status === "fail").map(([key]) => key);
  const unverified = Object.entries(guardrails).filter(([, value]) => value.status === "unverified").map(([key]) => key);
  reasons.push(...failed.map((key) => `regression_${key}`), ...unverified.map((key) => `unverified_${key}`));
  if (delta !== null && delta < 0) reasons.push("balanced_accuracy_decreased");
  if (delta !== null && delta <= 0) reasons.push("balanced_accuracy_did_not_improve");
  if (uncertainty.interval === null || uncertainty.interval.lower <= 0) reasons.push("interval_does_not_establish_improvement");
  let outcome: "insufficient_evidence" | "regression" | "no_supported_difference" | "candidate_for_review";
  if (!settled || !complete || delta === null) outcome = "insufficient_evidence";
  else if (failed.length || delta < 0) outcome = "regression";
  else if (delta === 0) outcome = "no_supported_difference";
  else if (input.cohort === "development" || !minimumsMet || unverified.length) outcome = "insufficient_evidence";
  else if (!uncertainty.interval || uncertainty.interval.lower <= 0) outcome = "no_supported_difference";
  else outcome = "candidate_for_review";
  const descriptions = {
    insufficient_evidence: "Keep the baseline. Evidence is incomplete, exploratory, too small, or a required guardrail is unverified.",
    regression: "Keep the baseline. The candidate regressed on this observed slice; this is not a population-wide claim.",
    no_supported_difference: "Keep the baseline. This comparison does not establish an improvement; it does not prove equivalence.",
    candidate_for_review: "The candidate merits human review on this labeled slice. Activation, rollback and live next-use measurement require a separate decision.",
  };
  const meanSessionDelta = distribution(sessionAccuracyDeltas).mean;
  return {
    schema_version: 1, batch_sha256: input.batch_sha256, source_manifest_sha256: input.source_manifest_sha256,
    cohort: input.cohort, analysis: "fixed_threshold_paired_comparison",
    criteria, threshold: criteria.threshold,
    coverage: { preparation_exclusions: input.preparation_exclusions,
      planned_pairs: input.pairs.length, complete_valid_pairs: complete, excluded_incomplete_or_invalid_pairs: input.pairs.length - complete,
      complete_pair_sessions: clusters.size, complete_pair_labels: { yes: baseline.yes, no: baseline.no }, arms: coverage },
    metrics: { baseline, candidate, balanced_accuracy_delta: delta, positive_recall_delta: recallDelta, disagreements },
    guardrails, cost: { ...costs, rate_usd_per_million_input_tokens: SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS,
      basis: "reported input tokens at the configured published rate; not a provider invoice; estimates are not measured usage" },
    latency, uncertainty: { ...uncertainty, floors, minimums_met: minimumsMet,
      qualified: input.cohort === "prospective" && minimumsMet && settled && uncertainty.interval !== null,
      interpretation: input.cohort === "development" || !minimumsMet ? "Exploratory interval only; not an independent supported win." : "Session-cluster sampling uncertainty on this labeled slice, not proof of causal task benefit." },
    session_sensitivity: {
      accuracy_delta: distribution(sessionAccuracyDeltas), balanced_accuracy_delta: distribution(sessionBalancedDeltas),
      single_class_sessions: clusterList.length - sessionBalancedDeltas.length,
      improved_sessions: sessionAccuracyDeltas.filter((value) => value > 0).length,
      worsened_sessions: sessionAccuracyDeltas.filter((value) => value < 0).length,
      unchanged_sessions: sessionAccuracyDeltas.filter((value) => value === 0).length,
      leave_one_session_out: { ...distribution(leaveOneOut), nonpositive: leaveOneOut.filter((value) => value <= 0).length,
        undefined: clusterList.length >= 2 ? clusterList.length - leaveOneOut.length : clusterList.length },
      aggregate_gain_vanishes_under_equal_session_weight: delta !== null && delta > 0 && meanSessionDelta !== null && meanSessionDelta <= 0,
      aggregate_gain_not_shared_by_positive_class: delta !== null && delta > 0 && recallDelta !== null && recallDelta <= 0,
    },
    decision: { outcome, explanation: descriptions[outcome], reasons, production_changed: false, activation_authorized: false },
    limitations: [
      "Behavioral proxies and co-loads are not relevance judgments or task-outcome evidence. Task benefit and composition quality remain unmeasured.",
      "Labels are selectively observed. Rejected injections censor counterfactual usefulness. No load or missing feedback is not a negative label.",
      "Historical comparisons are exploratory; current descriptions do not reproduce historical payloads and provider revision may be opaque. Usage logs do not prove session completion or trace completeness; prospective membership is observational, not causal randomization.",
      "Primary quality metrics use only complete valid pairs. All reserved attempts and invalid/unresolved responses are reported separately.",
      "Minimum sample and latency floors are reporting safeguards, not power or precision guarantees. Do not tune or extend this test until it wins.",
    ],
  };
}

export function renderSkillRuntimeReport(report: ReturnType<typeof analyzePairedSkillRuntime>): string {
  const value = (number: number | null) => number === null ? "unavailable" : number.toFixed(4);
  return ["# Skill runtime paired report", "", `Outcome: **${report.decision.outcome}**`, "", report.decision.explanation, "",
    `Evidence: batch \`${report.batch_sha256}\`; ${report.cohort} cohort.`, "",
    `Complete valid pairs: ${report.coverage.complete_valid_pairs}/${report.coverage.planned_pairs}; sessions: ${report.coverage.complete_pair_sessions}; yes/no: ${report.metrics.baseline.yes}/${report.metrics.baseline.no}.`, "",
    "| Measure | Baseline | Candidate |", "|---|---:|---:|",
    `| Balanced accuracy | ${value(report.metrics.baseline.balanced_accuracy)} | ${value(report.metrics.candidate.balanced_accuracy)} |`,
    `| Positive recall | ${value(report.metrics.baseline.positive_recall)} | ${value(report.metrics.candidate.positive_recall)} |`,
    `| Negative rejection rate | ${value(report.metrics.baseline.negative_rejection_rate)} | ${value(report.metrics.candidate.negative_rejection_rate)} |`, "",
    `Paired balanced-accuracy change: ${value(report.metrics.balanced_accuracy_delta)}.`,
    `95% session-cluster interval: ${report.uncertainty.interval ? `[${value(report.uncertainty.interval.lower)}, ${value(report.uncertainty.interval.upper)}]` : "unavailable"}; ${report.uncertainty.valid_resamples} valid resamples, ${report.uncertainty.omitted_class_missing_resamples} omitted.`, "",
    "## Regression checks", "", ...Object.entries(report.guardrails).map(([name, check]) => `- ${name}: **${check.status}** — ${check.reason}`), "",
    "## Evidence limits", "", ...report.limitations.map((text) => `- ${text}`), "",
    "No production change or activation is authorized by this report. See report.json for all denominators, attrition and session sensitivity.", ""].join("\n");
}
