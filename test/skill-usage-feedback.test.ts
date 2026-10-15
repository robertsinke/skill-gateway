import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { searchSkillUsageTurns, updateSkillUsageFeedback } from "../src/skill-usage-feedback.ts";
import { promptDigest } from "../src/usage-events.ts";

const query = "Find the next open time and invoice terms";

function fixture(directory: string) {
  const events = join(directory, "usage-events.jsonl");
  const queries = join(directory, "queries.jsonl");
  const feedback = join(directory, "skill-usage-feedback.jsonl");
  const gate = {
    event_type: "gate_decision",
    user_id: "user-a",
    session_id: "session-a",
    turn_id: "turn-a",
    turn_id_source: "pi_hooks_use_bridge",
    platform: "pi",
    prompt_sha256: promptDigest(query),
    gate_status: "pass",
    gate_model: "jev-1.13.0",
    probability: 0.91,
    threshold: 0.5,
    candidate_names: ["calendar", "invoice-review"],
    injected_skill_names: ["calendar", "invoice-review"],
    candidate_rankings: [
      { rank: 1, name: "calendar", search_score: 5.2 },
      { rank: 2, name: "invoice-review", search_score: 4.7 },
    ],
    input_tokens: 234,
    jev_list_cost_usd: 0.000009828,
    timestamp: "2026-10-14T18:00:00.000Z",
  };
  const load = {
    event_type: "skill_load",
    user_id: "user-a",
    session_id: "session-a",
    turn_id: "turn-a",
    turn_id_source: "pi_hooks_use_bridge",
    platform: "pi",
    skill_name: "calendar",
    timestamp: "2026-10-14T18:00:03.000Z",
  };
  writeFileSync(events, `${JSON.stringify(gate)}\n${JSON.stringify(load)}\n`);
  writeFileSync(queries, `${JSON.stringify({ user_id: "user-a", session_id: "session-a", turn_id: "turn-a", query, date: "2026-10-14T18:00:00.000Z", reaction: "negative", followup: "ignore" })}\n`);
  return {
    events,
    queries,
    feedback,
    env: { SKILL_GATEWAY_EVENTS: events, SKILL_GATEWAY_LOG: queries, SKILL_GATEWAY_FEEDBACK: feedback },
  };
}

describe("skill usage feedback", () => {
  it("exposes verified injected reads as a separate behavior proxy", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-search-"));
    try {
      const { env } = fixture(directory);
      const result = searchSkillUsageTurns({ query: "invoice" }, env);
      assert.equal(result.total, 1);
      assert.equal(result.results[0]?.turn_id, "turn-a");
      assert.equal(result.results[0]?.query_match_status, "matched_hash");
      assert.deepEqual(result.results[0]?.loaded_skill_names, ["calendar"]);
      assert.deepEqual(result.results[0]?.loaded_injected_skill_names, ["calendar"]);
      assert.equal(result.results[0]?.query_present, true);
      assert.equal(JSON.stringify(result).includes(query), false);
      assert.equal(searchSkillUsageTurns({ session_id: "session-a", turn_id: "missing" }, env).total, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores exact per-injected-skill relevance labels and keeps unlabeled skills unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-labels-"));
    try {
      const { env } = fixture(directory);
      const result = updateSkillUsageFeedback({
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        user_skill_feedback: [
          { skill_name: "calendar", relevance: "relevant" },
          { skill_name: "invoice-review", relevance: "not_relevant" },
        ],
      }, env);
      assert.equal(result.status, "created");
      assert.deepEqual(result.feedback.user_skill_feedback, [
        { skill_name: "calendar", relevance: "relevant" },
        { skill_name: "invoice-review", relevance: "not_relevant" },
      ]);
      assert.deepEqual(result.feedback.should_not_inject_skill_names, []);
      assert.deepEqual(result.feedback.should_not_load_skill_names, []);
      assert.throws(() => updateSkillUsageFeedback({
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        user_skill_feedback: [{ skill_name: "not-injected", relevance: "relevant" }],
      }, env), /not injected/);
      assert.throws(() => updateSkillUsageFeedback({
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        user_skill_feedback: [{ skill_name: "calendar", relevance: "relevant" }, { skill_name: "calendar", relevance: "unsure" }],
      }, env), /Duplicate per-skill feedback/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends private snapshots, preserves comments, and never mutates usage logs", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-update-"));
    try {
      const { env, events, queries, feedback } = fixture(directory);
      const beforeEvents = readFileSync(events, "utf8");
      const beforeQueries = readFileSync(queries, "utf8");
      const input = {
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        user_skill_feedback: [
          { skill_name: "calendar", relevance: "relevant" as const },
          { skill_name: "invoice-review", relevance: "unsure" as const },
        ],
        comment: "The user marked calendar relevant.",
        comment_source: "assistant_paraphrase" as const,
      };
      const created = updateSkillUsageFeedback(input, env);
      assert.equal(created.status, "created");
      assert.equal(created.feedback.schema_version, 4);
      assert.equal(created.feedback.comment_present, true);
      assert.equal(JSON.stringify(created).includes(input.comment), false);
      assert.equal(statSync(feedback).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(feedback, "utf8").trim()).comment, input.comment);
      assert.deepEqual(searchSkillUsageTurns({ session_id: "session-a", turn_id: "turn-a", user_id: "user-a" }, env).results[0]?.feedback?.user_skill_feedback, input.user_skill_feedback);
      assert.equal(updateSkillUsageFeedback(input, env).status, "unchanged");

      const updated = updateSkillUsageFeedback({
        ...input,
        user_skill_feedback: [{ skill_name: "calendar", relevance: "unsure" }],
        comment: undefined,
        comment_source: undefined,
      }, env);
      assert.equal(updated.status, "updated");
      assert.equal(updated.feedback.comment_present, true);
      assert.deepEqual(updated.feedback.user_skill_feedback, [{ skill_name: "calendar", relevance: "unsure" }]);
      assert.equal(readFileSync(events, "utf8"), beforeEvents);
      assert.equal(readFileSync(queries, "utf8"), beforeQueries);
      assert.equal(readFileSync(feedback, "utf8").trim().split("\n").length, 2);
      assert.throws(() => updateSkillUsageFeedback({ ...input, session_id: "wrong" }, env), /No exact linked turn/);
      assert.throws(() => updateSkillUsageFeedback({ ...input, should_not_inject_skill_names: ["not-injected"] }, env), /not injected/);
      assert.throws(() => updateSkillUsageFeedback({ ...input, should_not_load_skill_names: ["not-loaded"] }, env), /not verified as loaded/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
