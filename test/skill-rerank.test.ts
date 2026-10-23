import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSkillRerankRequest, evaluateSkillRerank } from "../src/skill-rerank.ts";

const candidates = [
  { name: "calendar", description: "Schedule meetings" },
  { name: "inbox", description: "Read mail" },
];

describe("skill reranking", () => {
  it("asks for independent fit judgments for each shortlist candidate", () => {
    const request = buildSkillRerankRequest("Schedule a meeting", candidates);
    assert.deepEqual(Object.keys(request.questions), ["fit_0", "fit_1"]);
    assert.equal(request.state.candidates.length, 2);
    assert.match(request.questions.fit_0.instructions, /independently/);
  });

  it("selects every candidate above threshold and records input usage", async () => {
    const result = await evaluateSkillRerank("Schedule a meeting", candidates, {
      apiKey: "test",
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "jev-1.13.0");
        return new Response(JSON.stringify({
          answers: { fit_0: { noul: 0.8 }, fit_1: { noul: 0.1 } },
          usage: { input_tokens: 120, output_tokens: 2 },
        }));
      },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.selected, ["calendar"]);
    assert.equal(result.input_tokens, 120);
    assert.equal(result.cost_usd, 0.00000504);
    assert.equal(result.request_attempted, true);
  });

  it("fails the whole rerank safely if an answer is malformed", async () => {
    const result = await evaluateSkillRerank("Schedule a meeting", candidates, {
      apiKey: "test",
      fetcher: async () => new Response(JSON.stringify({ answers: { fit_0: { noul: 0.8 } } })),
    });
    assert.equal(result.status, "error");
    assert.equal(result.reason, "invalid_answers");
    assert.deepEqual(result.selected, []);
  });
});
