import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzePairedSkillRuntime, renderSkillRuntimeReport, type ReportObservation, type SkillRuntimeReportInput } from "../src/skill-runtime-report.ts";

const criteria = {
  threshold: 0.5, minimum_sessions: 20, minimum_yes: 30, minimum_no: 30,
  positive_recall_max_drop: 0.05, input_cost_max_increase: 0.1, p95_latency_max_increase: 0.2,
  invalid_response_rate_must_not_increase: true, balanced_accuracy_must_improve: true,
  bootstrap_session_resamples: 10_000, bootstrap_interval: 0.95,
};
function observation(probability: number, inputTokens = 100, latency = 100): ReportObservation {
  return { attempted: true, result: { status: probability >= 0.5 ? "pass" : "reject", probability,
    request_attempted: true, input_tokens: inputTokens, latency_ms: latency, execution_id: "private-execution" } };
}
function experiment(sessions = 20): SkillRuntimeReportInput {
  const pairs: SkillRuntimeReportInput["pairs"] = [];
  for (let i = 0; i < sessions; i++) {
    // Both classes in every cluster, with a consistent candidate benefit.
    for (const label of ["yes", "no", "yes", "no"] as const) pairs.push({
      session: `PRIVATE_SESSION_${i}`, label,
      baseline: observation(0.8), candidate: observation(label === "yes" ? 0.8 : 0.2),
    });
  }
  return { batch_sha256: "a".repeat(64), source_manifest_sha256: "b".repeat(64),
    cohort: "prospective", criteria, preparation_exclusions: {}, pairs };
}
function run(change: (input: SkillRuntimeReportInput) => void) {
  const input = experiment(); change(input); return analyzePairedSkillRuntime(input);
}

describe("paired runtime reports", () => {
  it("recognizes a supported prospective improvement without authorizing activation", () => {
    const report = analyzePairedSkillRuntime(experiment());
    assert.equal(report.coverage.complete_valid_pairs, 80);
    assert.equal(report.metrics.baseline.tp, 40);
    assert.equal(report.metrics.baseline.fp, 40);
    assert.equal(report.metrics.candidate.tn, 40);
    assert.equal(report.metrics.balanced_accuracy_delta, 0.5);
    assert.equal(report.metrics.disagreements.candidate_only_correct, 40);
    assert.deepEqual(report.uncertainty.interval, { lower: 0.5, upper: 0.5 });
    assert.equal(report.uncertainty.valid_resamples, 10_000);
    assert.equal(report.uncertainty.qualified, true);
    assert.equal(report.decision.outcome, "candidate_for_review");
    assert.equal(report.decision.activation_authorized, false);
    assert.equal(report.decision.production_changed, false);
    assert.ok(Object.values(report.guardrails).every((check) => check.status === "pass"));
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    assert.ok(!renderSkillRuntimeReport(report).includes("PRIVATE"));
  });

  it("keeps development gains exploratory even with a positive interval and sufficient counts", () => {
    const report = run((input) => { input.cohort = "development"; });
    assert.equal(report.metrics.balanced_accuracy_delta, 0.5);
    assert.equal(report.uncertainty.qualified, false);
    assert.equal(report.decision.outcome, "insufficient_evidence");
    assert.ok(report.decision.reasons.includes("development_evidence_only"));
  });

  it("rejects positive-recall regression even if balanced accuracy improves", () => {
    const report = run((input) => {
      let positives = 0;
      for (const pair of input.pairs) if (pair.label === "yes" && positives++ < 3) pair.candidate = observation(0.1);
    });
    assert.ok(report.metrics.balanced_accuracy_delta! > 0);
    assert.equal(report.metrics.candidate.positive_recall, 0.925);
    assert.equal(report.guardrails.positive_recall.status, "fail");
    assert.equal(report.decision.outcome, "regression");
  });

  it("checks cost and p95 guardrails at their frozen limits, not an opaque combined score", () => {
    const atLimit = run((input) => { for (const pair of input.pairs) pair.candidate = observation(pair.label === "yes" ? 0.8 : 0.2, 110, 120); });
    assert.equal(atLimit.guardrails.mean_input_cost.status, "pass");
    assert.equal(atLimit.guardrails.p95_latency.status, "pass");
    for (const [tokens, latency, failed] of [[111, 100, "mean_input_cost"], [100, 121, "p95_latency"]] as const) {
      const report = run((input) => { for (const pair of input.pairs) pair.candidate = observation(pair.label === "yes" ? 0.8 : 0.2, tokens, latency); });
      assert.equal(report.guardrails[failed].status, "fail");
      assert.equal(report.decision.outcome, "regression");
    }
    const zero = run((input) => { for (const pair of input.pairs) { pair.baseline.result!.input_tokens = 0; pair.candidate.result!.input_tokens = 0; } });
    assert.equal(zero.guardrails.mean_input_cost.status, "pass");
  });

  it("makes missing usage, missing/legacy/resumed timings and insufficient timing samples unverified", () => {
    for (const mutate of [
      (pair: SkillRuntimeReportInput["pairs"][number]) => { pair.candidate.result!.input_tokens = null; },
      (pair: SkillRuntimeReportInput["pairs"][number]) => { pair.candidate.result!.latency_ms = null; },
      (pair: SkillRuntimeReportInput["pairs"][number]) => { pair.candidate.result!.execution_id = null; },
      (pair: SkillRuntimeReportInput["pairs"][number]) => { pair.candidate.result!.execution_id = "different-execution"; },
    ]) {
      const report = run((input) => mutate(input.pairs[0]!));
      assert.equal(report.decision.outcome, "insufficient_evidence");
      assert.ok(Object.values(report.guardrails).some((check) => check.status === "unverified"));
    }
    const small = experiment(2); small.pairs = small.pairs.slice(0, 7);
    assert.equal(analyzePairedSkillRuntime(small).guardrails.p95_latency.status, "unverified");
  });

  it("keeps class/session floors separate and never turns missing classes into zero rates", () => {
    const fewSessions = analyzePairedSkillRuntime(experiment(2));
    assert.equal(fewSessions.uncertainty.floors.sessions, false);
    assert.equal(fewSessions.decision.outcome, "insufficient_evidence");
    const singleClass = run((input) => { input.pairs = input.pairs.filter((pair) => pair.label === "yes"); });
    assert.equal(singleClass.metrics.baseline.negative_rejection_rate, null);
    assert.equal(singleClass.metrics.balanced_accuracy_delta, null);
    assert.equal(singleClass.uncertainty.interval, null);
    assert.equal(singleClass.uncertainty.omitted_class_missing_resamples, 10_000);
    assert.equal(singleClass.decision.outcome, "insufficient_evidence");
    const fewPositives = run((input) => { let yes = 0; input.pairs = input.pairs.filter((pair) => pair.label !== "yes" || yes++ < 2); });
    assert.equal(fewPositives.uncertainty.floors.yes, false);
    assert.equal(fewPositives.uncertainty.floors.sessions, true);
    assert.equal(fewPositives.decision.outcome, "insufficient_evidence");
  });

  it("reports all attempts and paired attrition; invalid candidate responses cannot disappear", () => {
    const report = run((input) => {
      input.pairs[0]!.candidate.result = { ...input.pairs[0]!.candidate.result!, status: "error", probability: null, input_tokens: null };
    });
    assert.equal(report.coverage.complete_valid_pairs, 79);
    assert.equal(report.coverage.excluded_incomplete_or_invalid_pairs, 1);
    assert.equal(report.coverage.arms.baseline.attempted_reservations, 80);
    assert.equal(report.coverage.arms.candidate.errors, 1);
    assert.equal(report.coverage.arms.candidate.invalid_response_rate, 1 / 80);
    assert.equal(report.guardrails.invalid_response_rate.status, "fail");
    assert.equal(report.guardrails.mean_input_cost.status, "unverified");
    assert.equal(report.decision.outcome, "regression");
    const invalid = run((input) => { for (const pair of input.pairs) pair.candidate.result = { ...pair.candidate.result!, status: "error", probability: null }; });
    assert.equal(invalid.coverage.arms.candidate.invalid_response_rate, 1);
    assert.equal(invalid.coverage.complete_valid_pairs, 0);
    assert.equal(invalid.decision.outcome, "insufficient_evidence");
  });

  it("reports pending and ambiguous attempts without pretending scoring is complete", () => {
    const report = run((input) => {
      input.pairs[0]!.baseline = { attempted: false, result: null };
      input.pairs[0]!.candidate = { attempted: true, result: null };
    });
    assert.equal(report.coverage.arms.baseline.pending, 1);
    assert.equal(report.coverage.arms.candidate.ambiguous, 1);
    assert.equal(report.coverage.arms.candidate.invalid_or_unresolved, 1);
    assert.equal(report.guardrails.invalid_response_rate.status, "unverified");
    assert.equal(report.decision.outcome, "insufficient_evidence");
  });

  it("does not claim equivalence on a tied result or an improvement whose interval crosses zero", () => {
    const tied = run((input) => { for (const pair of input.pairs) pair.candidate = structuredClone(pair.baseline); });
    assert.equal(tied.metrics.balanced_accuracy_delta, 0);
    assert.equal(tied.decision.outcome, "no_supported_difference");
    const uncertain = run((input) => {
      for (const [index, pair] of input.pairs.entries()) {
        if (index < 4) { pair.baseline = observation(pair.label === "yes" ? 0.1 : 0.8); pair.candidate = observation(pair.label === "yes" ? 0.8 : 0.1); }
        else { pair.baseline = observation(pair.label === "yes" ? 0.8 : 0.1); pair.candidate = structuredClone(pair.baseline); }
      }
    });
    assert.ok(uncertain.metrics.balanced_accuracy_delta! > 0);
    assert.equal(uncertain.uncertainty.interval!.lower, 0);
    assert.equal(uncertain.decision.outcome, "no_supported_difference");
  });

  it("resamples whole sessions deterministically, omits class-missing draws and reports sensitivity", () => {
    const input = experiment(2);
    input.pairs = [
      { session: "PRIVATE_YES", label: "yes", baseline: observation(0.1), candidate: observation(0.8) },
      { session: "PRIVATE_NO", label: "no", baseline: observation(0.8), candidate: observation(0.1) },
    ];
    const first = analyzePairedSkillRuntime(input), second = analyzePairedSkillRuntime(input);
    assert.deepEqual(first, second);
    assert.ok(first.uncertainty.omitted_class_missing_resamples > 4000);
    assert.ok(first.uncertainty.omitted_class_missing_resamples < 6000);
    assert.deepEqual(first.uncertainty.interval, { lower: 1, upper: 1 });
    assert.equal(first.session_sensitivity.single_class_sessions, 2);
    assert.equal(first.session_sensitivity.leave_one_session_out.undefined, 2);
    assert.ok(!JSON.stringify(first).includes("PRIVATE"));
    const skew = experiment(2); skew.pairs = [];
    for (let i = 0; i < 100; i++) skew.pairs.push({ session: "large", label: i % 2 ? "yes" : "no", baseline: observation(0.8), candidate: observation(i % 2 ? 0.8 : 0.1) });
    for (let i = 0; i < 3; i++) skew.pairs.push({ session: "small", label: "yes", baseline: observation(0.8), candidate: observation(0.1) });
    assert.equal(analyzePairedSkillRuntime(skew).session_sensitivity.aggregate_gain_vanishes_under_equal_session_weight, true);
  });
});
