import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildUsageTurnDataset, writeUsageTurnDataset } from "../src/usage-turn-dataset.ts";
import { promptDigest } from "../src/usage-events.ts";

const prompt = "Schedule the quarterly offsite";

function gateEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "gate_decision",
    user_id: "robert",
    session_id: "session-1",
    turn_id: "pi-run-1",
    turn_id_source: "pi_hooks_use_bridge",
    platform: "pi",
    timestamp: "2026-06-14T10:00:00.000Z",
    prompt_sha256: promptDigest(prompt),
    candidate_names: ["calendar", "travel"],
    candidate_rankings: [{ rank: 1, name: "calendar", search_score: 4.25 }],
    gate_status: "pass",
    gate_model: "jev-1.13.0",
    probability: 0.72,
    threshold: 0.5,
    injected_skill_names: ["calendar", "travel"],
    request_attempted: true,
    request_body_bytes: 1100,
    input_tokens: 275,
    estimated_input_tokens: 275,
    input_tokens_source: "typesafe_usage",
    jev_list_cost_usd: 0.00001155,
    cost_basis: "reported_input_tokens",
    cost_rate_usd_per_million_input_tokens: 0.042,
    cost_rate_source: "https://docs.typesafe.ai/models.md",
    ...overrides,
  };
}

describe("usage turn dataset", () => {
  it("joins only exact user/session/turn IDs and aggregates all verified loads", () => {
    const result = buildUsageTurnDataset([
      gateEvent(),
      { event_type: "skill_load", user_id: "robert", session_id: "session-1", turn_id: "pi-run-1", turn_id_source: "pi_hooks_use_bridge", platform: "pi", skill_name: "calendar", timestamp: "2026-06-14T10:01:00.000Z" },
      { event_type: "skill_load", user_id: "robert", session_id: "session-1", turn_id: "pi-run-1", turn_id_source: "pi_hooks_use_bridge", platform: "pi", skill_name: "weather", timestamp: "2026-06-14T10:02:00.000Z" },
      { event_type: "skill_load", user_id: "robert", session_id: "session-1", turn_id: null, skill_name: "unlinked", timestamp: "2026-06-14T10:03:00.000Z" },
    ], [
      { user_id: "robert", session_id: "session-1", turn_id: "pi-run-1", query: prompt, date: "2026-06-14T10:00:00.000Z", reaction: "positive", followup: "thanks" },
      { user_id: "robert", session_id: "session-1", query: "legacy unlinked", reaction: "negative" },
    ]);

    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.query, prompt);
    assert.equal(row.query_match_status, "matched_hash");
    assert.deepEqual(row.loaded_skill_names, ["calendar", "weather"]);
    assert.deepEqual(row.loaded_injected_skill_names, ["calendar"]);
    assert.deepEqual(row.loaded_not_injected_skill_names, ["weather"]);
    assert.equal(row.verified_load_count, 2);
    assert.equal(row.gate_decisions[0]?.jev_list_cost_usd, 0.00001155);
    assert.equal(row.gate_decisions[0]?.cost_basis, "reported_input_tokens");
    assert.deepEqual(row.turn_id_sources, ["pi_hooks_use_bridge"]);
    assert.equal(JSON.stringify(row).includes("reaction"), false);
    assert.equal(JSON.stringify(row).includes("followup"), false);
    assert.deepEqual(result.metadata.unlinked_event_counts, { gate_decisions: 0, skill_loads: 1, queries: 1, feedback_records: 0 });
  });

  it("adds explicit feedback only to the exact user/session/turn and excludes passive reactions", () => {
    const feedback = {
      schema_version: 2,
      event_type: "skill_usage_feedback",
      event_id: "feedback-1",
      timestamp: "2026-06-14T10:03:00.000Z",
      user_id: "robert",
      session_id: "session-1",
      turn_id: "pi-run-1",
      shortlist_rating: "not_helpful",
      should_not_inject_skill_names: ["travel"],
      should_not_load_skill_names: [],
      comment: "The shortlist missed the useful skill.",
      comment_source: "user_verbatim",
    };
    const result = buildUsageTurnDataset([gateEvent()], [{
      user_id: "robert", session_id: "session-1", turn_id: "pi-run-1", query: prompt, reaction: "positive", followup: "thanks",
    }], [
      feedback,
      { ...feedback, event_id: "wrong-user", user_id: "someone-else" },
      { ...feedback, event_id: "wrong-turn", turn_id: "other-turn" },
    ]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.feedback?.shortlist_rating, "not_helpful");
    assert.equal(result.rows[0]?.feedback?.comment, "The shortlist missed the useful skill.");
    assert.equal(JSON.stringify(result.rows[0]).includes("reaction"), false);
    assert.equal(JSON.stringify(result.rows[0]).includes("followup"), false);
    assert.equal(result.metadata.turns_with_shortlist_rating, 1);
    assert.deepEqual(result.metadata.unlinked_event_counts, { gate_decisions: 0, skill_loads: 0, queries: 0, feedback_records: 2 });
  });

  it("does not attach a query when its hash disagrees with the gate event", () => {
    const result = buildUsageTurnDataset([gateEvent()], [
      { user_id: "robert", session_id: "session-1", turn_id: "pi-run-1", query: "different text" },
    ]);
    assert.equal(result.rows[0]?.query, null);
    assert.equal(result.rows[0]?.query_match_status, "hash_mismatch");
  });

  it("writes private JSONL and metadata snapshots", () => {
    const result = buildUsageTurnDataset([gateEvent()], [{ user_id: "robert", session_id: "session-1", turn_id: "pi-run-1", query: prompt }]);
    const directory = mkdtempSync(join(tmpdir(), "usage-turn-dataset-"));
    const output = join(directory, "dataset.jsonl");
    writeUsageTurnDataset(result.rows, result.metadata, output);
    assert.equal(JSON.parse(readFileSync(output, "utf8").trim()).query, prompt);
    assert.equal(JSON.parse(readFileSync(`${output}.meta.json`, "utf8")).turn_count, 1);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(statSync(`${output}.meta.json`).mode & 0o777, 0o600);
  });
});
