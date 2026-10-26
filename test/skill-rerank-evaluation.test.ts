import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { analyzeRerankScores, chooseRerankThreshold, prepareRerankEvaluation, previewRerankEvaluation, reportRerankEvaluation, scoreRerankEvaluation, selectionMetrics, type ScoredRerankCase } from "../src/skill-rerank-evaluation.ts";
import { experimentDigest, runSkillRuntimeExperiment } from "../src/skill-runtime-experiment.ts";
import { promptDigest } from "../src/usage-events.ts";
import { CONSERVATIVE_RERANK_TRIAL, evaluateSkillRerank } from "../src/skill-rerank.ts";

const catalog = ["alpha", "beta", "gamma"].map((name) => ({ name, description: "PRIVATE_DESCRIPTION " + name }));
const temporary: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(), "rerank-eval-test-")); temporary.push(path); return path; }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function sample(turn = "turn", session = "PRIVATE_SESSION") {
  const identity = { user_id: "PRIVATE_USER", session_id: session, turn_id: turn };
  const query = "PRIVATE_PROMPT " + turn;
  return {
    gate: { ...identity, event_type: "gate_decision", timestamp: "2026-10-23T00:00:00.000Z", gate_status: "pass", probability: 0.8, threshold: 0.5,
      prompt_sha256: promptDigest(query), candidate_names: ["alpha", "beta", "gamma"], injected_skill_names: ["alpha", "beta", "gamma"], experiment_arm: "control",
      candidate_rankings: [{ name: "alpha", rank: 3 }, { name: "beta", rank: 1 }, { name: "gamma", rank: 2 }] },
    query: { ...identity, query },
    feedback: { ...identity, schema_version: 5, event_type: "skill_usage_feedback", event_id: turn, timestamp: "2026-10-23T00:01:00.000Z",
      injection_decision: null, user_skill_feedback: [{ skill_name: "alpha", relevance: "relevant" }, { skill_name: "beta", relevance: "not_relevant" }],
      should_not_inject_skill_names: [], should_not_load_skill_names: [], comment: "PRIVATE_COMMENT", comment_source: "user_verbatim" },
  };
}
function fixture(samples = [sample()], extras: Record<string, unknown>[] = []) {
  const dir = temp(); const sources = { events: join(dir, "events"), queries: join(dir, "queries"), feedback: join(dir, "feedback") };
  writeFileSync(sources.events, [...samples.map((item) => item.gate), ...extras].map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(sources.queries, samples.map((item) => JSON.stringify(item.query)).join("\n") + "\n");
  writeFileSync(sources.feedback, samples.map((item) => JSON.stringify(item.feedback)).join("\n") + "\n");
  const run = join(dir, "run"), output = join(dir, "evaluation"); runSkillRuntimeExperiment(sources, run);
  return { dir, run, output };
}
function prepared(samples = [sample()]) { const f = fixture(samples); const preview = prepareRerankEvaluation(f.run, f.output, catalog); return { ...f, preview }; }
const response = () => new Response(JSON.stringify({ answers: { fit_0: { noul: 0.9 }, fit_1: { noul: 0.1 }, fit_2: { noul: 0.6 } }, usage: { input_tokens: 100, output_tokens: 10 } }));
function row(id: string, session: string, positive = 0.9, negative = 0.1): ScoredRerankCase {
  return { id, session, candidates: ["alpha", "beta", "gamma"], labels: [{ name: "alpha", relevant: true }, { name: "beta", relevant: false }],
    ranks: [{ name: "alpha", rank: 3 }, { name: "beta", rank: 1 }, { name: "gamma", rank: 2 }], body: "",
    fits: [{ name: "alpha", probability: positive }, { name: "beta", probability: negative }, { name: "gamma", probability: 0.6 }] };
}

describe("per-skill metrics and session-held-out calibration", () => {
  it("compares filtering with keep-all/top-k on identical labels and leaves unknowns unknown", () => {
    const { report } = analyzeRerankScores([row("1", "s1"), row("2", "s2")]);
    assert.equal(report.keep_all.tp, 2); assert.equal(report.keep_all.fp, 2);
    assert.equal(report.current_reranker_0_5.tp, 2); assert.equal(report.current_reranker_0_5.fp, 0);
    assert.equal(report.current_reranker_0_5.selected_without_labels, 2);
    assert.equal(report.current_reranker_0_5.labeled_selection_precision, 1);
    assert.equal(report.top_one.fn, 2); assert.equal(report.top_one.fp, 2);
    assert.equal(report.top_three.fn, 0);
    assert.equal(report.production_changed, false);
  });

  it("holds whole sessions out; the held-out low positive cannot lower its own cutoff", () => {
    const low = row("low", "s1", 0.1, 0.05), high = row("high", "s2", 0.9, 0.8);
    assert.equal(chooseRerankThreshold([high]), 0.9);
    assert.equal(chooseRerankThreshold([low]), 0.1);
    const result = analyzeRerankScores([low, high]).report;
    assert.equal(result.proposed_development_threshold, 0.1);
    assert.equal(result.session_held_out_calibration.calibrated.tp, 1);
    assert.equal(result.session_held_out_calibration.calibrated.fn, 1);
    assert.equal(result.session_held_out_calibration.folds, 2);
    assert.equal(result.session_held_out_calibration.calibrated.relevant_retention, 0.5);
  });

  it("supports multiple useful skills and identifies completely versus partly missed turns", () => {
    const multi = row("1", "s1"); multi.labels[1]!.relevant = true;
    const one = selectionMetrics([multi], () => ["alpha"]);
    assert.equal(one.multi_relevant_turns, 1); assert.equal(one.partially_missed_positive_turns, 1); assert.equal(one.fully_missed_positive_turns, 0);
    assert.equal(selectionMetrics([multi], () => []).fully_missed_positive_turns, 1);
  });

  it("does not manufacture ranks or class rates, or calibrate without both training classes", () => {
    const item = row("1", "s1"); item.ranks = [];
    const report = analyzeRerankScores([item]).report;
    assert.equal(report.top_one.excluded_missing_rank_labels, 2);
    assert.equal(report.top_one.relevant_retention, null);
    assert.equal(report.session_held_out_calibration.skipped_sessions, 1);
    item.labels = [{ name: "alpha", relevant: true }];
    assert.equal(chooseRerankThreshold([item]), null);
    assert.equal(analyzeRerankScores([item]).report.current_reranker_0_5.irrelevant_removal, null);
  });
});

describe("explicit conservative rerank policy", () => {
  it("retains supporting fits at 0.1 without changing the original default or sending the cutoff", async () => {
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(Object.hasOwn(body, "threshold"), false);
      return new Response(JSON.stringify({ answers: { fit_0: { noul: 0.15 }, fit_1: { noul: 0.05 }, fit_2: { noul: 0.6 } } }));
    };
    const baseline = await evaluateSkillRerank("task", catalog, { apiKey: "test", fetcher });
    const trial = await evaluateSkillRerank("task", catalog, { apiKey: "test", fetcher,
      judgment: CONSERVATIVE_RERANK_TRIAL.judgment, threshold: CONSERVATIVE_RERANK_TRIAL.threshold });
    assert.deepEqual(baseline.selected, ["gamma"]);
    assert.deepEqual(trial.selected, ["alpha", "gamma"]);
  });

  it("rejects invalid local cutoffs without a request", async () => {
    let calls = 0;
    for (const threshold of [-1, 1.1, NaN, Infinity]) {
      const result = await evaluateSkillRerank("task", catalog, { apiKey: "test", threshold,
        fetcher: async () => { calls++; return response(); } });
      assert.equal(result.status, "error"); assert.equal(result.request_attempted, false);
    }
    assert.equal(calls, 0);
  });
});

describe("rerank evidence pipeline", () => {
  it("joins live records only by exact identity and matching prompt/candidates", () => {
    const s = sample(); s.gate.experiment_arm = "treatment";
    const live = { ...s.gate, event_type: "skill_rerank_experiment", experiment_arm: "treatment", status: "ok",
      rerank_policy: CONSERVATIVE_RERANK_TRIAL.id, rerank_judgment: CONSERVATIVE_RERANK_TRIAL.judgment,
      rerank_threshold: CONSERVATIVE_RERANK_TRIAL.threshold, selected_names: ["alpha", "gamma"],
      fits: [{ name: "alpha", probability: 0.15 }, { name: "beta", probability: 0.05 }, { name: "gamma", probability: 0.6 }] };
    const f = fixture([s], [live, { ...live, user_id: "other-user" }, { ...live, turn_id: "other-turn" }, { ...live, session_id: "other-session" }]);
    const preview = prepareRerankEvaluation(f.run, f.output, catalog);
    assert.equal(preview.live.events, 4); assert.equal(preview.live.exact_linked_events, 1);
    assert.equal(preview.live.events_without_dataset_turn, 3); assert.equal(preview.live.labeled_turns, 1);
    assert.equal(preview.live.cached_quality.tp, 1); assert.equal(preview.live.cached_quality.fp, 0);
    assert.equal(preview.live.arm_gate_counts.treatment, 1);
    assert.equal(preview.live.cached_quality_by_policy[CONSERVATIVE_RERANK_TRIAL.id]!.tp, 1);
    const mismatchedPolicy = fixture([s], [{ ...live, rerank_threshold: 0.5 }]);
    assert.equal(prepareRerankEvaluation(mismatchedPolicy.run, mismatchedPolicy.output, catalog).live.exclusions.policy_mismatch, 1);
    const mixed = fixture([s], [{ ...live, experiment_arm: "control" }]);
    assert.equal(prepareRerankEvaluation(mixed.run, mixed.output, catalog).live.exclusions.arm_mismatch, 1);
    const wrong = fixture([s], [{ ...live, prompt_sha256: "wrong" }]);
    assert.equal(prepareRerankEvaluation(wrong.run, wrong.output, catalog).live.exclusions.hash_not_verified, 1);
    const duplicate = fixture([s], [live, live]);
    assert.equal(prepareRerankEvaluation(duplicate.run, duplicate.output, catalog).live.exclusions.multiple_reranks, 1);
  });

  it("freezes only intended outbound fields and preserves private labels separately", () => {
    const f = prepared(); const batch = JSON.parse(readFileSync(join(f.output, "batch.json"), "utf8"));
    const body = JSON.parse(batch.cases[0].body);
    assert.deepEqual(Object.keys(body.state).sort(), ["candidates", "prompt"]);
    assert.deepEqual(Object.keys(body.state.candidates[0]).sort(), ["description", "name"]);
    for (const secret of ["PRIVATE_COMMENT", "PRIVATE_USER", "PRIVATE_SESSION", "relevance"]) assert.ok(!batch.cases[0].body.includes(secret));
    assert.ok(!JSON.stringify(f.preview).includes("PRIVATE"));
    assert.equal(statSync(f.output).mode & 0o777, 0o700); assert.equal(statSync(join(f.output, "batch.json")).mode & 0o777, 0o600);
    assert.throws(() => prepareRerankEvaluation(f.run, f.output, catalog));
    const missing = fixture(); assert.equal(prepareRerankEvaluation(missing.run, missing.output, []).exclusions.missing_or_ambiguous_description, 1);
  });

  it("freezes relevance-v2 separately without changing default live wording or leaking labels", async () => {
    const f = prepared();
    const baseline = JSON.parse(readFileSync(join(f.output, "batch.json"), "utf8"));
    const variantPath = join(f.dir, "relevance-evaluation");
    const preview = prepareRerankEvaluation(f.run, variantPath, catalog, "relevance-v2");
    assert.equal(preview.judgment, "relevance-v2");
    const variant = JSON.parse(readFileSync(join(variantPath, "batch.json"), "utf8"));
    const first = JSON.parse(baseline.cases[0].body), second = JSON.parse(variant.cases[0].body);
    assert.deepEqual(first.state, second.state);
    assert.equal(first.model, second.model);
    assert.match(first.questions.fit_0.criteria.false, /redundant/);
    assert.match(second.questions.fit_0.instructions, /Judge relevance, not necessity/);
    assert.match(second.questions.fit_0.criteria.false, /Do not reject just because another candidate overlaps/);
    let calls = 0;
    await scoreRerankEvaluation(variantPath, { maxCostUsd: 0.01, apiKey: "test", fetcher: async (_url, init) => {
      assert.equal(init?.body, variant.cases[0].body); calls++; return response();
    } });
    assert.equal(calls, 1);
    assert.equal(previewRerankEvaluation(f.output).judgment, "current-v1");
    assert.deepEqual(JSON.parse(readFileSync(join(f.output, "batch.json"), "utf8")), baseline);
  });

  it("scores frozen bodies once, preserves multi-skill answers, and produces a private report", async () => {
    const f = prepared([sample("1", "s1"), sample("2", "s2")]); let calls = 0;
    const batch = JSON.parse(readFileSync(join(f.output, "batch.json"), "utf8"));
    const fetcher: typeof fetch = async (_url, init) => {
      assert.equal(init?.body, batch.cases[calls].body); assert.equal(init?.redirect, "error");
      assert.equal(readdirSync(join(f.output, "attempts")).length, calls + 1); calls++; return response();
    };
    const scored = await scoreRerankEvaluation(f.output, { maxCostUsd: 0.01, apiKey: "test", fetcher });
    assert.equal(scored.external_calls, 2);
    assert.equal((await scoreRerankEvaluation(f.output, { maxCostUsd: 0.01, apiKey: "test", fetcher })).external_calls, 0);
    assert.equal(calls, 2);
    const reportPath = join(f.dir, "report"); const result = reportRerankEvaluation(f.output, reportPath);
    assert.equal(result.coverage.scored_turns, 2); assert.equal(result.analysis.current_reranker_0_5.tp, 2);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    assert.equal(statSync(join(reportPath, "skill-diagnostics.json")).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(join(reportPath, "manifest.json"), "utf8"));
    assert.equal(manifest.artifacts["report.json"], experimentDigest(readFileSync(join(reportPath, "report.json"))));
  });

  it("requires budget, detects tampering, and never sends modified candidate extras", async () => {
    const f = prepared(); let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return response(); };
    await assert.rejects(scoreRerankEvaluation(f.output, { maxCostUsd: 0, apiKey: "test", fetcher }), /Budget/);
    const path = join(f.output, "batch.json"); const batch = JSON.parse(readFileSync(path, "utf8"));
    const body = JSON.parse(batch.cases[0].body); body.state.candidates[0].feedback = "PRIVATE_LABEL";
    batch.cases[0].body = JSON.stringify(body); writeFileSync(path, JSON.stringify(batch));
    const manifestPath = join(f.output, "manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.batch_sha256 = experimentDigest(readFileSync(path)); writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(scoreRerankEvaluation(f.output, { maxCostUsd: 0.01, apiKey: "test", fetcher }), /Invalid case input/);
    assert.equal(calls, 0);
  });

  it("stops on invalid answers, resumes only unattempted rows, and blocks an unresolved reservation", async () => {
    const f = prepared([sample("1"), sample("2")]); let calls = 0;
    await scoreRerankEvaluation(f.output, { maxCostUsd: 0.01, apiKey: "test", fetcher: async () => { calls++; return new Response('{"answers":{}}'); } });
    assert.equal(calls, 1);
    const result = reportRerankEvaluation(f.output, join(f.dir, "partial-report"));
    assert.equal(result.coverage.errors, 1); assert.equal(result.coverage.pending, 1);
    assert.equal(result.completed_policy_with_error_fallback.tp, 1);
    assert.equal(result.completed_policy_with_error_fallback.fp, 1);
    await scoreRerankEvaluation(f.output, { maxCostUsd: 0.01, apiKey: "test", fetcher: async () => { calls++; return response(); } });
    assert.equal(calls, 2);
    rmSync(join(f.output, "results", "000001.json"));
    await assert.rejects(scoreRerankEvaluation(f.output, { maxCostUsd: 0.01, apiKey: "test", fetcher: async () => { calls++; return response(); } }), /Unresolved attempt/);
    assert.equal(calls, 2);
  });

  it("keeps CLI preparation, preview and reporting offline and rejects implicit execution", () => {
    const f = prepared(); const blocker = join(f.dir, "offline.mjs"); writeFileSync(blocker, 'globalThis.fetch=()=>{throw new Error("NETWORK_CALLED")};');
    const cli = resolve("scripts/evaluate-skill-rerank.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--import", blocker, cli, ...args], { encoding: "utf8" });
    const preview = run("--batch", f.output); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).external_calls, 0);
    const report = run("--batch", f.output, "--report", "--output", join(f.dir, "cli-report")); assert.equal(report.status, 0, report.stderr);
    assert.ok(!report.stdout.includes("PRIVATE"));
    const denied = run("--batch", f.output, "--execute"); assert.equal(denied.status, 1); assert.ok(!denied.stderr.includes(f.dir));
    assert.equal(readdirSync(join(f.output, "attempts")).length, 0);
  });
});
