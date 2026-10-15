import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promptDigest } from "../src/usage-events.ts";

const prompt = "Prepare the weekly calendar";

describe("skill usage feedback CLI", () => {
  it("runs search and update commands against exact linked IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-feedback-cli-"));
    try {
      const events = join(directory, "events.jsonl");
      const queries = join(directory, "queries.jsonl");
      const feedback = join(directory, "feedback.jsonl");
      writeFileSync(events, `${JSON.stringify({
        event_type: "gate_decision",
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        prompt_sha256: promptDigest(prompt),
        gate_status: "pass",
        candidate_names: ["calendar"],
        injected_skill_names: ["calendar"],
        timestamp: "2026-10-14T18:00:00.000Z",
      })}\n`);
      writeFileSync(queries, `${JSON.stringify({ user_id: "user-a", session_id: "session-a", turn_id: "turn-a", query: prompt })}\n`);
      const env = {
        ...process.env,
        SKILL_GATEWAY_EVENTS: events,
        SKILL_GATEWAY_LOG: queries,
        SKILL_GATEWAY_FEEDBACK: feedback,
      };
      const cli = join(process.cwd(), "src/skill-usage-feedback-cli.ts");
      const searchOutput = execFileSync(process.execPath, ["--experimental-strip-types", cli, "search", JSON.stringify({ query: "weekly calendar" })], { env, encoding: "utf8" });
      const search = JSON.parse(searchOutput);
      assert.equal(search.count, 1);
      assert.equal(search.results[0].turn_id, "turn-a");
      assert.equal(searchOutput.includes(prompt), false);

      const updateInput = {
        user_id: "user-a",
        session_id: "session-a",
        turn_id: "turn-a",
        user_skill_feedback: [{ skill_name: "calendar", relevance: "relevant" }],
        comment: "Calendar fit this search.",
        comment_source: "assistant_paraphrase",
      };
      const updateOutput = execFileSync(process.execPath, ["--experimental-strip-types", cli, "update", "-"], { env, encoding: "utf8", input: JSON.stringify(updateInput) });
      assert.equal(JSON.parse(updateOutput).status, "created");
      assert.equal(updateOutput.includes("Calendar fit this search."), false);
      const stored = JSON.parse(readFileSync(feedback, "utf8"));
      assert.deepEqual(stored.should_not_inject_skill_names, []);
      assert.equal(stored.schema_version, 4);
      assert.deepEqual(stored.user_skill_feedback, [{ skill_name: "calendar", relevance: "relevant" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
