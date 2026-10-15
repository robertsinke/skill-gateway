import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSkillGate, skillGateListCostUsd } from "../src/skill-gate.ts";

const candidates = [
  { name: "calendar", description: "Schedule meetings and manage event invites.", path: "/private/library/calendar" },
];

describe("skill gate", () => {
  it("calculates Jev list cost from input tokens only", () => {
    assert.equal(skillGateListCostUsd(916), 0.000038472);
    assert.equal(skillGateListCostUsd(0), 0);
    assert.equal(skillGateListCostUsd(-1), null);
  });

  it("sends only prompt and candidate name/description, then passes above threshold", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const decision = await evaluateSkillGate("Schedule a team offsite", candidates, {
      apiKey: "test-key",
      fetcher: async (url, init) => {
        sent = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify({ answers: { any_skill: { noul: 0.71 } }, usage: { input_tokens: 184, output_tokens: 2 } }), { status: 200 });
      },
    });

    assert.deepEqual(decision, { status: "pass", probability: 0.71, model: "jev-1.13.0", request_attempted: true, input_tokens: 184, output_tokens: 2 });
    assert.equal(sent?.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(sent?.init.headers).get("authorization"), "Bearer test-key");
    const request = JSON.parse(String(sent?.init.body));
    assert.equal(request.model, "jev-1.13.0");
    assert.equal(request.state.prompt, "Schedule a team offsite");
    assert.deepEqual(request.state.candidates, [{ name: "calendar", description: "Schedule meetings and manage event invites." }]);
    assert.equal(JSON.stringify(request).includes("/private/library"), false);
    assert.equal(request.questions.any_skill.type, "noul");
  });

  it("rejects below threshold", async () => {
    const decision = await evaluateSkillGate("Thanks", candidates, {
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({ answers: { any_skill: { noul: 0.49 } } }), { status: 200 }),
    });
    assert.equal(decision.status, "reject");
    assert.equal(decision.probability, 0.49);
  });

  it("fails closed on unavailable credentials or malformed responses", async () => {
    const noKey = await evaluateSkillGate("Task", candidates, { apiKey: "" });
    const badAnswer = await evaluateSkillGate("Task", candidates, {
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }),
    });
    const httpError = await evaluateSkillGate("Task", candidates, {
      apiKey: "test-key",
      fetcher: async () => new Response("", { status: 503 }),
    });
    assert.equal(noKey.status, "error");
    assert.equal(noKey.reason, "credential_unavailable");
    assert.equal(noKey.request_attempted, false);
    assert.equal(badAnswer.status, "error");
    assert.equal(badAnswer.reason, "invalid_probability");
    assert.equal(httpError.status, "error");
    assert.equal(httpError.reason, "http_503");
  });
});
