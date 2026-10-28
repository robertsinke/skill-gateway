import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageTurnDataset } from "./usage-turn-dataset.ts";
import { latestSkillUsageFeedback, parseSkillUsageFeedback } from "./skill-usage-feedback-record.ts";

type RecordRow = Record<string, unknown>;
type Dataset = ReturnType<typeof buildUsageTurnDataset>;
type Turn = Dataset["rows"][number];
type Gate = Turn["gate_decisions"][number];
export type ExperimentSources = { events: string; queries: string; feedback: string };
const SOURCE_NAMES = ["events", "queries", "feedback"] as const;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIMITATIONS = [
  "Development diagnostics only; these observations are not a held-out test or a production recommendation.",
  "Explicit feedback is selective. Rates describe labeled eligible turns, not all tasks or users.",
  "Loads, co-loads and outside-shortlist loads are behavioral proxies, not correctness or task-benefit labels.",
  "Gate rejection censors exposure. No read, prior loads, missing feedback and unsure are not negative labels.",
  "Depth measures retention of exposed, explicitly labeled skills, not library-wide recall. Unlabeled skills remain unknown.",
  "Historical descriptions and payload revisions are unavailable; recorded probabilities are not a current replay.",
];

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Unlike the live permissive reader, the audit accounts for every nonblank line. */
export function parseExperimentJsonl(bytes: Buffer) {
  const rows: RecordRow[] = [];
  let malformed = 0;
  let nonObjects = 0;
  let blank = 0;
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) { blank++; continue; }
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) nonObjects++;
      else rows.push(row as RecordRow);
    } catch { malformed++; }
  }
  return { rows, counts: { object_rows: rows.length, malformed_lines: malformed, non_object_lines: nonObjects, blank_lines: blank } };
}

function count(values: string[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

type Example = { yes: boolean; probability: number; threshold: number | null };
function confusion(examples: Example[], threshold: number | "recorded") {
  let tp = 0, fn = 0, tn = 0, fp = 0, missingThreshold = 0;
  for (const item of examples) {
    const cutoff = threshold === "recorded" ? item.threshold : threshold;
    if (cutoff === null || cutoff < 0 || cutoff > 1) { missingThreshold++; continue; }
    const pass = item.probability >= cutoff;
    if (item.yes) { if (pass) tp++; else fn++; }
    else { if (pass) fp++; else tn++; }
  }
  const recall = ratio(tp, tp + fn);
  const rejection = ratio(tn, tn + fp);
  return {
    threshold, evaluated: tp + fn + tn + fp, excluded_missing_threshold: missingThreshold,
    yes: tp + fn, no: tn + fp, tp, fn, tn, fp,
    positive_recall: recall, negative_rejection_rate: rejection,
    false_positive_rate: ratio(fp, tn + fp), false_negative_rate: ratio(fn, tp + fn),
    balanced_accuracy: recall === null || rejection === null ? null : (recall + rejection) / 2,
  };
}

function key(row: { user_id?: unknown; session_id?: unknown; turn_id?: unknown }): string {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  return JSON.stringify([text(row.user_id), text(row.session_id), text(row.turn_id)]);
}

function eligibility(turn: Turn, ambiguousCandidates: Set<string>): string | null {
  if (turn.query_match_status !== "matched_hash" || !turn.query?.trim()) return "query_not_hash_linked";
  if (turn.gate_decisions.length !== 1) return "gate_count_not_one";
  const gate = turn.gate_decisions[0]!;
  if (gate.status !== "pass" && gate.status !== "reject") return "gate_not_valid_decision";
  if (gate.probability === null || gate.probability < 0 || gate.probability > 1) return "invalid_probability";
  if (!gate.candidate_names.length) return "empty_candidates";
  if (ambiguousCandidates.has(key(turn))) return "ambiguous_candidates";
  return null;
}

function rankMap(gate: Gate): Map<string, number> {
  const names = count(gate.candidate_rankings.map((item) => item.name));
  const ranks = count(gate.candidate_rankings.map((item) => String(item.rank)));
  return new Map(gate.candidate_rankings.flatMap((item) =>
    item.rank !== null && Number.isSafeInteger(item.rank) && item.rank > 0 && names[item.name] === 1 && ranks[String(item.rank)] === 1
      ? [[item.name, item.rank] as const] : []));
}

/** Pure aggregate analysis: never returns prompts, comments, skill names or identities. */
export function analyzeSkillRuntime(events: RecordRow[], queries: RecordRow[], feedback: RecordRow[]) {
  const dataset = buildUsageTurnDataset(events, queries, feedback);
  // The dataset deliberately deduplicates strings. Audit ambiguity before that normalization.
  const ambiguousCandidates = new Set(events.filter((row) => {
    if (row.event_type !== "gate_decision") return false;
    const names = row.candidate_names;
    return !Array.isArray(names) || names.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim())
      || new Set(names).size !== names.length;
  }).map(key));
  const examples: Example[] = [];
  const eligibleTurns: Turn[] = [];
  const sessions = new Set<string>();
  const exclusions: string[] = [];
  const labels = count(dataset.rows.map((row) => row.feedback?.injection_decision ?? "unlabeled"));
  const depth = [1, 3, 5].map((k) => ({
    depth: k, turns: 0, relevant_total: 0, relevant_ranked: 0, relevant_missing_rank: 0, relevant_retained: 0,
    not_relevant_total: 0, not_relevant_ranked: 0, not_relevant_missing_rank: 0, not_relevant_exposed: 0,
    unsure_exposed: 0, unlabeled_exposed: 0, candidates_missing_rank: 0,
  }));
  let retrievalTurns = 0, excludedSkillLabels = 0, statusDisagreements = 0;
  for (const turn of dataset.rows) {
    const label = turn.feedback?.injection_decision;
    if (label === "yes" || label === "no") {
      const exclusion = eligibility(turn, ambiguousCandidates);
      if (exclusion) exclusions.push(exclusion);
      else {
        const gate = turn.gate_decisions[0]!;
        eligibleTurns.push(turn);
        examples.push({ yes: label === "yes", probability: gate.probability!, threshold: gate.threshold });
        sessions.add(JSON.stringify([turn.user_id, turn.session_id]));
        if (gate.threshold !== null && gate.threshold >= 0 && gate.threshold <= 1
          && (gate.probability! >= gate.threshold) !== (gate.status === "pass")) statusDisagreements++;
      }
    }
    if (turn.query_match_status !== "matched_hash" || turn.gate_decisions.length !== 1 || ambiguousCandidates.has(key(turn))) continue;
    const gate = turn.gate_decisions[0]!;
    const skillLabels = turn.feedback?.user_skill_feedback ?? [];
    if (!skillLabels.length) continue;
    retrievalTurns++;
    const ranks = rankMap(gate);
    // Per-skill relevance judgments are valid only for verified exposed skill names.
    const validLabels = skillLabels.filter((item) => turn.injected_skill_names.includes(item.skill_name) && gate.candidate_names.includes(item.skill_name));
    excludedSkillLabels += skillLabels.length - validLabels.length;
    const byName = new Map(validLabels.map((item) => [item.skill_name, item.relevance]));
    for (const row of depth) {
      row.turns++;
      row.candidates_missing_rank += gate.candidate_names.filter((name) => !ranks.has(name)).length;
      for (const item of validLabels) {
        const rank = ranks.get(item.skill_name);
        if (item.relevance === "relevant") {
          row.relevant_total++;
          if (rank === undefined) row.relevant_missing_rank++;
          else { row.relevant_ranked++; if (rank <= row.depth) row.relevant_retained++; }
        } else if (item.relevance === "not_relevant") {
          row.not_relevant_total++;
          if (rank === undefined) row.not_relevant_missing_rank++;
          else { row.not_relevant_ranked++; if (rank <= row.depth) row.not_relevant_exposed++; }
        }
      }
      for (const name of gate.candidate_names) {
        const rank = ranks.get(name);
        if (rank === undefined || rank > row.depth) continue;
        if (!byName.has(name)) row.unlabeled_exposed++;
        else if (byName.get(name) === "unsure") row.unsure_exposed++;
      }
    }
  }
  const fixed = confusion(examples, 0.5);
  const outside = dataset.rows.filter((row) => row.loaded_not_injected_skill_names.length > 0).length;
  const coLoads = dataset.rows.filter((row) => row.loaded_skill_names.length > 1).length;
  const validFeedback = feedback.filter((row) => parseSkillUsageFeedback(row) !== null).length;
  const latestFeedback = latestSkillUsageFeedback(feedback).size;
  const report = {
    schema_version: 1, analysis: "historical_development_only",
    input_records: {
      events: {
        total: events.length,
        gate_decisions: events.filter((row) => row.event_type === "gate_decision").length,
        skill_loads: events.filter((row) => row.event_type === "skill_load").length,
        ignored_other_events: events.filter((row) => row.event_type !== "gate_decision" && row.event_type !== "skill_load").length,
      },
      queries: {
        total: queries.length, with_query_text: queries.filter((row) => typeof row.query === "string").length,
        ignored_without_query_text: queries.filter((row) => typeof row.query !== "string").length,
      },
      feedback: {
        total: feedback.length, valid_snapshots: validFeedback, invalid_snapshots: feedback.length - validFeedback,
        latest_snapshots: latestFeedback, superseded_snapshots: validFeedback - latestFeedback,
      },
    },
    audit: {
      ...dataset.metadata, labels, eligible_labeled_sessions: sessions.size,
      skill_labels: count(dataset.rows.flatMap((row) => (row.feedback?.user_skill_feedback ?? []).map((item) => item.relevance))),
    },
    gate: {
      eligible_yes_no: examples.length, excluded_yes_no: exclusions.length, exclusion_counts: count(exclusions),
      unsure: labels.unsure ?? 0, unlabeled: labels.unlabeled ?? 0, status_threshold_disagreements: statusDisagreements,
      fixed_0_5: fixed, recorded_thresholds: confusion(examples, "recorded"),
      development_threshold_sweep: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((value) => confusion(examples, value)),
    },
    retrieval: {
      labeled_turns: retrievalTurns, excluded_unexposed_or_non_candidate_labels: excludedSkillLabels,
      excluded_labeled_turns: dataset.rows.filter((row) => (row.feedback?.user_skill_feedback.length ?? 0) > 0).length - retrievalTurns,
      development_depths: depth.map((row) => ({ ...row, observed_relevant_retention: ratio(row.relevant_retained, row.relevant_ranked) })),
    },
    stages: {
      gate_statuses: count(dataset.rows.flatMap((row) => row.gate_decisions.map((gate) =>
        gate.status === "pass" || gate.status === "reject" || gate.status === "error" ? gate.status : "unknown"))),
      turns_with_empty_candidates: dataset.rows.filter((row) => row.gate_decisions.some((gate) => !gate.candidate_names.length)).length,
      turns_with_injection: dataset.rows.filter((row) => row.injected_skill_names.length > 0).length,
      turns_with_injected_load: dataset.rows.filter((row) => row.loaded_injected_skill_names.length > 0).length,
      turns_with_outside_shortlist_load: outside, turns_with_co_loads: coLoads,
      composition_quality: "unmeasured", task_benefit: "unmeasured",
    },
    hypotheses: [
      { kind: "gate_wording", supporting_turns: fixed.fp, denominator: fixed.no, interpretation: "False injections on explicit no labels support investigating the frozen wording hypothesis, not a proven fix." },
      { kind: "positive_recall_risk", supporting_turns: fixed.fn, denominator: fixed.yes, interpretation: "Missed explicit yes labels constrain stricter gating; preserve positive usefulness." },
      { kind: "possible_retrieval_miss", supporting_turns: outside, denominator: dataset.rows.length, interpretation: "Outside-shortlist loads prioritize review but may be unrelated or intentional discovery." },
      { kind: "composition_evidence_gap", supporting_turns: coLoads, denominator: dataset.rows.length, interpretation: "Co-load events alone cannot assess conflicts, instruction application or task outcomes." },
    ],
    limitations: LIMITATIONS,
  };
  return { dataset, report, eligibleTurns };
}

export { digest as experimentDigest, provenance as experimentCodeProvenance, outsideRepo as validateExperimentOutput };

/** Shared reader for completed private U1 snapshots; never follows artifact symlinks. */
export function loadSkillRuntimeSnapshot(path: string) {
  const directory = lstatSync(path);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("Expected a private nonsymlink directory.");
  const read = (name: string) => {
    const target = join(path, name);
    const stat = lstatSync(target);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Expected a private nonsymlink file.");
    return readFileSync(target);
  };
  const manifestBytes = read("manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schema_version !== 1 || manifest.status !== "complete") throw new Error("Incomplete source run.");
  const contents = new Map<string, Buffer>();
  for (const name of ["events.jsonl", "queries.jsonl", "feedback.jsonl", "dataset.jsonl", "report.json"]) {
    const info = manifest.artifacts?.[name];
    const bytes = read(name);
    if (info?.sha256 !== digest(bytes) || info.bytes !== bytes.length) throw new Error("Source artifact hash mismatch.");
    contents.set(name, bytes);
  }
  if (manifest.capture?.consistency !== "no_source_changes_detected") throw new Error("Source run changed during capture; create a new run.");
  const finishedAt = manifest.capture.finished_at;
  const capturedAt = typeof finishedAt === "string" ? Date.parse(finishedAt) : NaN;
  if (!Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== finishedAt) throw new Error("Invalid source capture time.");
  const events = parseExperimentJsonl(contents.get("events.jsonl")!).rows;
  const queries = parseExperimentJsonl(contents.get("queries.jsonl")!).rows;
  const feedback = parseExperimentJsonl(contents.get("feedback.jsonl")!).rows;
  const analysis = analyzeSkillRuntime(events, queries, feedback);
  if (JSON.stringify(analysis.dataset.rows) !== JSON.stringify(parseExperimentJsonl(contents.get("dataset.jsonl")!).rows)) {
    throw new Error("Frozen dataset differs from the current builder; create a new U1 run.");
  }
  return { events, queries, feedback, manifest_sha256: digest(manifestBytes), captured_at: capturedAt, analysis };
}

function fingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error("Required source is not a regular file.");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function provenance() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const patch = git("diff", "HEAD", "--binary");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean).sort();
  const dirty = createHash("sha256").update(patch);
  for (const name of untracked) {
    const path = join(ROOT, name);
    dirty.update("\0" + name + "\0");
    // Do not follow untracked symlinks into private files outside the checkout.
    if (lstatSync(path).isFile()) dirty.update(readFileSync(path));
  }
  return { revision: git("rev-parse", "HEAD").toString().trim(), tracked_patch_sha256: digest(patch), dirty_tree_sha256: dirty.digest("hex") };
}

function outsideRepo(output: string): void {
  const parent = realpathSync(dirname(output));
  const rel = relative(realpathSync(ROOT), parent);
  if (!rel || (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel))) {
    throw new Error("Experiment output must be outside the repository.");
  }
}

/** Snapshot inputs once, analyze those exact bytes, then publish a completion manifest last. */
export function runSkillRuntimeExperiment(sources: ExperimentSources, outputPath: string) {
  const output = resolve(outputPath);
  outsideRepo(output);
  const startedAt = new Date().toISOString();
  const before = SOURCE_NAMES.map((name) => fingerprint(sources[name]));
  const captures = SOURCE_NAMES.map((name) => {
    const bytes = readFileSync(sources[name]);
    if (!bytes.toString("utf8").trim()) throw new Error("Required source is empty.");
    const parsed = parseExperimentJsonl(bytes);
    if (!parsed.rows.length) throw new Error("Required source has no JSON object records.");
    return { name, bytes, parsed, sha256: digest(bytes) };
  });
  const changed = SOURCE_NAMES.filter((name, index) => fingerprint(sources[name]) !== before[index]);
  const analysis = analyzeSkillRuntime(captures[0]!.parsed.rows, captures[1]!.parsed.rows, captures[2]!.parsed.rows);
  const sourceAudit = Object.fromEntries(captures.map((item) => [item.name, {
    bytes: item.bytes.length, sha256: item.sha256, ...item.parsed.counts,
  }]));
  const report = {
    ...analysis.report,
    sources: sourceAudit,
    capture: {
      started_at: startedAt, finished_at: new Date().toISOString(), changed_during_capture: changed,
      consistency: changed.length ? "source_changes_detected" : "no_source_changes_detected",
      caveat: "Separate append-only logs are not a transaction. Stable file stats cannot prove causal cross-file completeness.",
    },
  };
  const code = provenance();
  // mkdir is the exclusive reservation. A failed run remains incomplete; never reuse it.
  mkdirSync(output, { mode: 0o700 });
  const artifacts: Record<string, { bytes: number; sha256: string }> = {};
  const write = (name: string, bytes: Buffer | string) => {
    writeFileSync(join(output, name), bytes, { flag: "wx", mode: 0o600 });
    artifacts[name] = { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
  };
  for (const item of captures) write(`${item.name}.jsonl`, item.bytes);
  write("dataset.jsonl", analysis.dataset.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  write("report.json", JSON.stringify(report, null, 2) + "\n");
  write("manifest.json.tmp", JSON.stringify({
    schema_version: 1, status: "complete", code, sources: sourceAudit,
    dataset_schema_version: analysis.dataset.metadata.schema_version,
    analysis: "historical_development_only", capture: report.capture, artifacts: { ...artifacts },
  }, null, 2) + "\n");
  renameSync(join(output, "manifest.json.tmp"), join(output, "manifest.json"));
  return report;
}
