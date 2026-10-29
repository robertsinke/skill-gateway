import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findLatestGateEvent, formatGateDetails, formatGateFooter, sumRecordedGateCosts } from "../src/pi-gate-telemetry.ts";

const current = {
  event_type: "gate_decision",
  session_id: "session-1",
  prompt_sha256: "current-hash",
  gate_status: "reject",
  probability: 0.31,
  threshold: 0.5,
  candidate_names: ["docs", "testing"],
  candidate_rankings: [
    { rank: 1, name: "docs", search_score: 3.25 },
    { rank: 2, name: "testing", search_score: 2.1 },
  ],
  injected_skill_names: [],
  request_attempted: true,
  request_body_bytes: 920,
  state_characters: 540,
  input_tokens: 225,
  estimated_input_tokens: 230,
  output_tokens: 1,
  jev_list_cost_usd: 0.00000945,
  cost_basis: "reported_input_tokens",
  cost_rate_usd_per_million_input_tokens: 0.042,
  cost_rate_source: "https://docs.typesafe.ai/models.md",
};

describe("Pi gate telemetry", () => {
  it("finds the event for this session and prompt, not just the latest event", () => {
    const contents = [
      JSON.stringify({ ...current, prompt_sha256: "older-hash" }),
      JSON.stringify(current),
      JSON.stringify({ ...current, session_id: "other-session" }),
    ].join("\n");
    assert.deepEqual(findLatestGateEvent(contents, "session-1", "current-hash"), current);
    assert.equal(findLatestGateEvent(contents, "session-1", "missing"), null);
  });

  it("does not let synthetic not-evaluated rows mask a real gate for the same prompt", () => {
    const queued = { ...current, turn_id: "queued-turn", gate_status: "not_evaluated", turn_id_source: "pi_queued_input" };
    assert.deepEqual(findLatestGateEvent([JSON.stringify(current), JSON.stringify(queued)].join("\n"), "session-1", "current-hash"), current);
    assert.equal(findLatestGateEvent(JSON.stringify(queued), "session-1", "current-hash"), null);
  });

  it("shows Jev's shortlist-level score, retrieval ranks, injection count, and reported usage", () => {
    const status = formatGateFooter(current, { total: 0.00006019, includes_estimates: false });
    assert.match(status, /reject/);
    assert.match(status, /Jev 0\.31\/0\.50/);
    assert.match(status, /2→0/);
    assert.match(status, /225 tok/);
    assert.match(status, /total \$0\.00006019/);
    assert.doesNotMatch(status, /\$0\.00000945/);
    assert.match(status, /docs 3\.3/);
    assert.match(status, /testing 2\.1/);
  });

  it("sums all recorded gate costs and marks totals containing estimates", () => {
    const contents = [
      JSON.stringify(current),
      JSON.stringify({ ...current, jev_list_cost_usd: 0.000001, cost_basis: "estimated_input_tokens" }),
      JSON.stringify({ ...current, event_type: "skill_load", jev_list_cost_usd: 9 }),
      "{incomplete",
    ].join("\n");
    assert.deepEqual(sumRecordedGateCosts(contents), { total: 0.00001045, includes_estimates: true });
  });

  it("includes rerank request costs in cumulative totals", () => {
    const contents = [
      JSON.stringify({ event_type: "gate_decision", jev_list_cost_usd: 0.00001, cost_basis: "reported_input_tokens" }),
      JSON.stringify({ event_type: "skill_rerank_experiment", cost_usd: 0.00002, input_tokens: 500, request_attempted: true }),
      JSON.stringify({ event_type: "skill_rerank_shadow", cost_usd: 0.00003, request_attempted: true }),
    ].join("\n");
    const total = sumRecordedGateCosts(contents);
    assert.ok(Math.abs(total.total - 0.00006) < 1e-12);
    assert.equal(total.includes_estimates, true);
  });

  it("shows only the cumulative recorded cost", () => {
    const status = formatGateFooter(current, { total: 0.00006019, includes_estimates: false });
    assert.match(status, /total \$0\.00006019/);
    assert.doesNotMatch(status, /\$0\.00000945/);
    assert.match(formatGateFooter(current, { total: 0.00006019, includes_estimates: true }), /total ~\$0\.00006019/);
    assert.match(formatGateFooter(current), /total n\/a/);
    assert.match(formatGateFooter({ ...current, experiment_arm: "control" }, { total: 0.00006019, includes_estimates: false }), /rerank control/);
    assert.match(formatGateFooter({ ...current, experiment_arm: "treatment", rerank_selected_names: ["docs"] }, { total: 0.00006019, includes_estimates: false }), /rerank 1\/2/);
    const details = formatGateDetails(current, null, true, { total: 0.00006019, includes_estimates: true });
    assert.match(details, /\$0\.00000945/);
    assert.match(details, /Recorded log total: ~\$0\.00006019/);
    assert.match(details, /at least one included cost was estimated/);
    const unavailable = formatGateDetails({ ...current, experiment_arm: "treatment", rerank_selected_names: ["docs"] }, null, true, null);
    assert.match(unavailable, /Experiment arm: treatment · rerank selected docs/);
    assert.match(unavailable, /Recorded log total: unavailable/);
  });

  it("does not mark a rerank total estimated when its input tokens were reported", () => {
    const total = sumRecordedGateCosts(JSON.stringify({
      event_type: "skill_rerank_experiment", cost_usd: 0.00002, input_tokens: 500, request_attempted: true,
    }));
    assert.ok(Math.abs(total.total - 0.00002) < 1e-12);
    assert.equal(total.includes_estimates, false);
  });

  it("keeps estimated usage distinct from provider-reported usage", () => {
    const status = formatGateFooter({ ...current, input_tokens: undefined });
    assert.match(status, /~230 tok/);
    assert.match(status, /total n\/a/);
    const details = formatGateDetails({ ...current, input_tokens: undefined, jev_list_cost_usd: 0.00000966, cost_basis: "estimated_input_tokens" }, { state: { prompt: "local only" } }, true);
    assert.match(details, /4 bytes\/token estimate/);
    assert.match(details, /about \$0\.00000966/);
    assert.match(details, /docs.typesafe.ai\/models\.md/);
    assert.match(details, /authorization header omitted/);
  });
});
