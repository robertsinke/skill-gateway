import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { analyzeSkillRuntime, parseExperimentJsonl, runSkillRuntimeExperiment } from "../src/skill-runtime-experiment.ts";
import { promptDigest } from "../src/usage-events.ts";

const prompt = "PRIVATE_PROMPT_CANARY";
const identity = { user_id: "PRIVATE_USER", session_id: "PRIVATE_SESSION", turn_id: "PRIVATE_TURN" };
function gate(overrides: Record<string, unknown> = {}) {
  return {
    ...identity, timestamp: "2026-10-17T00:00:00Z", event_type: "gate_decision", prompt_sha256: promptDigest(prompt),
    candidate_names: ["PRIVATE_SKILL", "second", "third"],
    candidate_rankings: [
      { name: "PRIVATE_SKILL", rank: 1 }, { name: "second", rank: 3 }, { name: "third", rank: 5 },
    ],
    injected_skill_names: ["PRIVATE_SKILL", "second", "third"],
    probability: 0.8, threshold: 0.5, gate_status: "pass", gate_model: "jev-1.13.0", ...overrides,
  };
}
function query(overrides: Record<string, unknown> = {}) { return { ...identity, query: prompt, ...overrides }; }
function feedback(overrides: Record<string, unknown> = {}) {
  return {
    ...identity, schema_version: 5, event_type: "skill_usage_feedback", event_id: "PRIVATE_EVENT",
    timestamp: "2026-10-17T00:01:00Z", injection_decision: "no",
    user_skill_feedback: [
      { skill_name: "PRIVATE_SKILL", relevance: "not_relevant" }, { skill_name: "second", relevance: "relevant" },
    ],
    should_not_inject_skill_names: [], should_not_load_skill_names: [],
    comment: "PRIVATE_COMMENT", comment_source: "user_verbatim", ...overrides,
  };
}
const temporary: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "skill-runtime-test-")); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function files(dir: string) {
  const sources = { events: join(dir, "input-events.jsonl"), queries: join(dir, "input-queries.jsonl"), feedback: join(dir, "input-feedback.jsonl") };
  writeFileSync(sources.events, JSON.stringify(gate()) + "\nBROKEN PRIVATE_BAD_ROW\n[]\n");
  writeFileSync(sources.queries, JSON.stringify(query()) + "\n");
  writeFileSync(sources.feedback, JSON.stringify(feedback()) + "\n");
  return sources;
}

describe("runtime experiment aggregate analysis", () => {
  it("counts malformed/nonobject lines instead of silently dropping evidence", () => {
    const parsed = parseExperimentJsonl(Buffer.from('{"a":1}\nBROKEN PRIVATE\n[]\nnull\n42\n\n'));
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.counts.malformed_lines, 1);
    assert.equal(parsed.counts.non_object_lines, 3);
    assert.equal(parsed.counts.blank_lines, 2);
    assert.ok(!JSON.stringify(parsed.counts).includes("PRIVATE"));
  });

  it("computes gate counts, class denominators, recorded cutoffs and development sweeps", () => {
    const id2 = { turn_id: "two" };
    const { report } = analyzeSkillRuntime([gate(), gate({ ...id2, probability: 0.3, threshold: 0.2 })],
      [query(), query(id2)], [feedback(), feedback({ ...id2, injection_decision: "yes" })]);
    assert.equal(report.gate.eligible_yes_no, 2);
    assert.equal(report.gate.fixed_0_5.fp, 1);
    assert.equal(report.gate.fixed_0_5.fn, 1);
    assert.equal(report.gate.fixed_0_5.balanced_accuracy, 0);
    assert.equal(report.gate.recorded_thresholds.tp, 1);
    assert.equal(report.gate.recorded_thresholds.evaluated, 2);
    assert.equal(report.gate.development_threshold_sweep.length, 11);
    assert.equal(report.audit.eligible_labeled_sessions, 1);
  });

  it("keeps unsure, unlabeled, load-only and prior loads out of ground truth", () => {
    const events = [gate({ injected_skill_names: [], gate_status: "reject", probability: 0.1 }),
      gate({ turn_id: "unsure" }), gate({ turn_id: "unlabeled" }),
      { ...identity, turn_id: "prior", event_type: "skill_load", skill_name: "PRIVATE_SKILL" },
      { ...identity, event_type: "skill_load", skill_name: "outside" }];
    const { report } = analyzeSkillRuntime(events, [query(), query({ turn_id: "unsure" }), query({ turn_id: "unlabeled" })],
      [feedback({ injection_decision: "yes", user_skill_feedback: [] }), feedback({ turn_id: "unsure", injection_decision: "unsure" })]);
    assert.equal(report.gate.fixed_0_5.fn, 1);
    assert.equal(report.gate.fixed_0_5.no, 0);
    assert.equal(report.gate.fixed_0_5.balanced_accuracy, null);
    assert.equal(report.gate.fixed_0_5.false_positive_rate, null);
    assert.equal(report.gate.unsure, 1);
    assert.equal(report.gate.unlabeled, 2);
    assert.equal(report.stages.turns_with_outside_shortlist_load, 2);
  });

  it("accounts for ignored records, invalid feedback and superseded snapshots", () => {
    const report = analyzeSkillRuntime([gate(), { event_type: "other" }], [query(), {}],
      [feedback({ injection_decision: "yes" }), feedback(), {}]).report;
    assert.equal(report.input_records.events.total, 2);
    assert.equal(report.input_records.events.ignored_other_events, 1);
    assert.equal(report.input_records.queries.ignored_without_query_text, 1);
    assert.deepEqual(report.input_records.feedback, {
      total: 3, valid_snapshots: 2, invalid_snapshots: 1, latest_snapshots: 1, superseded_snapshots: 1,
    });
    assert.equal(report.gate.fixed_0_5.no, 1);
    assert.equal(report.gate.fixed_0_5.yes, 0);
  });

  it("isolates exact user/session/turn identities and reports unlinked feedback", () => {
    const { report } = analyzeSkillRuntime([gate()], [query()], [
      feedback({ user_id: "other" }), feedback({ session_id: "other" }), feedback({ turn_id: "other" }),
    ]);
    assert.equal(report.gate.eligible_yes_no, 0);
    assert.equal(report.audit.turns_with_explicit_feedback, 0);
    assert.equal((report.audit.unlinked_event_counts as { feedback_records: number }).feedback_records, 3);
  });

  it("reports mutually exclusive eligibility exclusions with reconciled counts", () => {
    const variants = [
      { query: "wrong", reason: "query_not_hash_linked" },
      { duplicate: true, reason: "gate_count_not_one" },
      { gate: { gate_status: "error", probability: null }, reason: "gate_not_valid_decision" },
      { gate: { probability: 1.5 }, reason: "invalid_probability" },
      { gate: { candidate_names: [] }, reason: "empty_candidates" },
      { gate: { candidate_names: ["duplicate", "duplicate"] }, reason: "ambiguous_candidates" },
    ];
    for (const item of variants) {
      const event = gate(item.gate);
      const { report } = analyzeSkillRuntime(item.duplicate ? [event, event] : [event],
        [query(item.query ? { query: item.query } : {})], [feedback()]);
      assert.equal(report.gate.eligible_yes_no, 0);
      assert.equal(report.gate.excluded_yes_no, 1);
      assert.equal(report.gate.exclusion_counts[item.reason], 1);
    }
  });

  it("does not coerce null probabilities or missing/invalid thresholds to zero", () => {
    const invalid = analyzeSkillRuntime([gate({ probability: null })], [query()], [feedback()]).report;
    assert.equal(invalid.gate.exclusion_counts.invalid_probability, 1);
    for (const threshold of [null, -1, 1.1]) {
      const report = analyzeSkillRuntime([gate({ threshold })], [query()], [feedback()]).report;
      assert.equal(report.gate.fixed_0_5.fp, 1);
      assert.equal(report.gate.recorded_thresholds.evaluated, 0);
      assert.equal(report.gate.recorded_thresholds.excluded_missing_threshold, 1);
    }
  });

  it("reports observed-label depth retention and unknown exposure without inferred negatives", () => {
    const report = analyzeSkillRuntime([gate()], [query()], [feedback()]).report;
    const [one, three, five] = report.retrieval.development_depths;
    assert.equal(one!.relevant_retained, 0);
    assert.equal(one!.not_relevant_exposed, 1);
    assert.equal(three!.relevant_retained, 1);
    assert.equal(three!.observed_relevant_retention, 1);
    assert.equal(five!.unlabeled_exposed, 1);
    assert.equal(five!.not_relevant_total, 1);
    const missing = analyzeSkillRuntime([gate({ candidate_rankings: [{ name: "PRIVATE_SKILL", rank: 1 }] })], [query()], [feedback()]).report;
    assert.equal(missing.retrieval.development_depths[0]!.relevant_missing_rank, 1);
    assert.equal(missing.retrieval.development_depths[0]!.observed_relevant_retention, null);
  });

  it("treats duplicate/invalid ranks as unknown and excludes unexposed labels", () => {
    const report = analyzeSkillRuntime([gate({ injected_skill_names: ["PRIVATE_SKILL"], candidate_rankings: [
      { name: "PRIVATE_SKILL", rank: 1 }, { name: "second", rank: 1 }, { name: "third", rank: -1 },
    ] })], [query()], [feedback()]).report;
    assert.equal(report.retrieval.excluded_unexposed_or_non_candidate_labels, 1);
    assert.equal(report.retrieval.development_depths[2]!.not_relevant_missing_rank, 1);
    assert.equal(report.retrieval.development_depths[2]!.candidates_missing_rank, 3);
  });

  it("never returns sensitive text, names, identities or raw error strings in aggregates", () => {
    const report = analyzeSkillRuntime([gate({ gate_status: "PRIVATE_ERROR" })], [query()], [feedback()]).report;
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    assert.equal(report.stages.gate_statuses.unknown, 1);
    assert.equal(report.stages.task_benefit, "unmeasured");
  });
});

describe("private local experiment runner", () => {
  it("captures exact bytes, publishes restrictive artifacts and manifest last, preserves inputs", () => {
    const dir = temp();
    const sources = files(dir);
    const inputBytes = Object.values(sources).map((path) => readFileSync(path));
    const output = join(dir, "run");
    const report = runSkillRuntimeExperiment(sources, output);
    assert.equal(report.sources.events.malformed_lines, 1);
    assert.equal(report.sources.events.non_object_lines, 1);
    assert.equal(report.capture.consistency, "no_source_changes_detected");
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    assert.equal(statSync(output).mode & 0o777, 0o700);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "complete");
    assert.match(manifest.code.revision, /^[a-f0-9]{40}$/);
    assert.match(manifest.code.dirty_tree_sha256, /^[a-f0-9]{64}$/);
    for (const [name, description] of Object.entries(manifest.artifacts)) {
      const info = description as { sha256: string; bytes: number };
      const path = join(output, name);
      const bytes = readFileSync(path);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), info.sha256);
      assert.equal(bytes.length, info.bytes);
    }
    assert.equal(statSync(join(output, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(output, "manifest.json.tmp")), false);
    Object.values(sources).forEach((path, index) => assert.deepEqual(readFileSync(path), inputBytes[index]));
    assert.deepEqual(readFileSync(join(output, "events.jsonl")), inputBytes[0]);
    const before = readFileSync(join(output, "manifest.json"));
    assert.throws(() => runSkillRuntimeExperiment(sources, output));
    assert.deepEqual(readFileSync(join(output, "manifest.json")), before);
  });

  it("fails safely on missing, empty or all-invalid required input before publication", () => {
    const dir = temp();
    const sources = files(dir);
    const output = join(dir, "run");
    assert.throws(() => runSkillRuntimeExperiment({ ...sources, events: join(dir, "missing") }, output));
    for (const contents of ["", " \n", "BROKEN\nnull\n"]) {
      writeFileSync(sources.events, contents);
      assert.throws(() => runSkillRuntimeExperiment(sources, output));
      assert.equal(existsSync(output), false);
    }
  });

  it("refuses repo outputs including symlinked parents and existing incomplete runs", () => {
    const dir = temp();
    const sources = files(dir);
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    assert.throws(() => runSkillRuntimeExperiment(sources, join(repo, "forbidden-experiment-output")), /outside the repository/);
    symlinkSync(repo, join(dir, "repo-link"), "dir");
    assert.throws(() => runSkillRuntimeExperiment(sources, join(dir, "repo-link", "forbidden")), /outside the repository/);
    const incomplete = join(dir, "incomplete");
    mkdirSync(incomplete);
    assert.throws(() => runSkillRuntimeExperiment(sources, incomplete));
    assert.equal(existsSync(join(incomplete, "manifest.json")), false);
  });

  it("runs end-to-end CLI without network and rejects scoring/unknown flags without disclosure", () => {
    const dir = temp();
    const sources = files(dir);
    const noNetwork = join(dir, "no-network.mjs");
    writeFileSync(noNetwork, 'globalThis.fetch = () => { throw new Error("NETWORK_CALLED"); };\n');
    const cli = resolve("scripts/evaluate-skill-runtime.ts");
    const args = ["--events", sources.events, "--queries", sources.queries, "--feedback", sources.feedback];
    const run = (...extra: string[]) => spawnSync(process.execPath,
      ["--experimental-strip-types", "--import", noNetwork, cli, ...args, ...extra], { encoding: "utf8" });
    const result = run("--output", join(dir, "cli-run"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).gate.fixed_0_5.fp, 1);
    assert.ok(!result.stdout.includes("PRIVATE"));
    assert.ok(!result.stdout.includes(dir));
    const invalid = run("--execute", "PRIVATE_ARG");
    assert.equal(invalid.status, 1);
    assert.ok(!invalid.stderr.includes("PRIVATE"));
    assert.ok(!invalid.stderr.includes(dir));
    const missing = run("--output", join(dir, "missing-parent", "run"));
    assert.equal(missing.status, 1);
    assert.ok(!missing.stderr.includes(dir));
  });
});
