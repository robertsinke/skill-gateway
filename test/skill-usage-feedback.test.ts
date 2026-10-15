import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { searchSkillUsageTurns, updateSkillUsageFeedback } from "../src/skill-usage-feedback.ts";
import { promptDigest } from "../src/usage-events.ts";

const query = "Please prepare the invoice for next week.";

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
    candidate_names: ["calendar"],
    injected_skill_names: ["calendar"],
    candidate_rankings: [{ rank: 1, name: "calendar", search_score: 5.2 }],
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
  it("searches exact linked turns without returning stored prompt or comment text", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-search-"));
    try {
      const { env } = fixture(directory);
      const result = searchSkillUsageTurns({ query: "invoice" }, env);
      assert.equal(result.total, 1);
      assert.equal(result.results[0]?.turn_id, "turn-a");
      assert.equal(result.results[0]?.query_match_status, "matched_hash");
      assert.equal(result.results[0]?.loaded_skill_names[0], "calendar");
      assert.equal(result.results[0]?.query_present, true);
      assert.equal(JSON.stringify(result).includes(query), false);
      assert.equal(searchSkillUsageTurns({ session_id: "session-a", turn_id: "missing" }, env).total, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores a shortlist rating without inventing per-skill labels", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-rating-"));
    try {
      const { env } = fixture(directory);
      const result = updateSkillUsageFeedback({
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        shortlist_rating: "helpful",
      }, env);
      assert.equal(result.status, "created");
      assert.equal(result.feedback.shortlist_rating, "helpful");
      assert.deepEqual(result.feedback.should_not_inject_skill_names, []);
      assert.deepEqual(result.feedback.should_not_load_skill_names, []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("appends private feedback, validates observed actions, and preserves prior comments on update", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-update-"));
    try {
      const { env, events, queries, feedback } = fixture(directory);
      const beforeEvents = readFileSync(events, "utf8");
      const beforeQueries = readFileSync(queries, "utf8");
      const input = {
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        shortlist_rating: "not_helpful" as const,
        should_not_inject_skill_names: ["calendar"],
        should_not_load_skill_names: ["calendar"],
        comment: "The user says this workflow did not need a skill.",
        comment_source: "assistant_paraphrase" as const,
      };
      const created = updateSkillUsageFeedback(input, env);
      assert.equal(created.status, "created");
      assert.equal(created.feedback.comment_present, true);
      assert.equal(created.feedback.shortlist_rating, "not_helpful");
      assert.equal(JSON.stringify(created).includes(input.comment), false);
      assert.equal(statSync(feedback).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(feedback, "utf8").trim()).comment, input.comment);
      assert.equal(searchSkillUsageTurns({ session_id: "session-a", turn_id: "turn-a", user_id: "user-a" }, env).results[0]?.feedback?.comment_present, true);
      assert.equal(searchSkillUsageTurns({ session_id: "session-a", turn_id: "turn-a", user_id: "user-a" }, env).results[0]?.feedback?.shortlist_rating, "not_helpful");
      assert.equal(updateSkillUsageFeedback(input, env).status, "unchanged");

      const cleared = updateSkillUsageFeedback({
        ...input,
        should_not_inject_skill_names: [],
        should_not_load_skill_names: [],
        comment: undefined,
        comment_source: undefined,
      }, env);
      assert.equal(cleared.status, "updated");
      assert.equal(cleared.feedback.should_not_inject_skill_names.length, 0);
      assert.equal(cleared.feedback.should_not_load_skill_names.length, 0);
      assert.equal(cleared.feedback.comment_present, true);
      assert.equal(cleared.feedback.shortlist_rating, "not_helpful");
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
