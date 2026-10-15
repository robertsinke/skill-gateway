import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.ts";
import { promptDigest } from "../src/usage-events.ts";

const envKeys = ["SKILL_GATEWAY_EVENTS", "SKILL_GATEWAY_LOG", "SKILL_GATEWAY_FEEDBACK"] as const;

describe("usage feedback MCP tools", () => {
  it("searches linked turns and writes a feedback snapshot through MCP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-usage-feedback-"));
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const prompt = "Review the project invoice";
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
      probability: 0.8,
      threshold: 0.5,
      candidate_names: ["calendar", "invoice-review"],
      injected_skill_names: ["calendar", "invoice-review"],
      timestamp: "2026-10-14T18:00:00.000Z",
    })}\n${JSON.stringify({ event_type: "skill_load", user_id: "user-a", session_id: "session-a", turn_id: "turn-a", skill_name: "calendar", timestamp: "2026-10-14T18:00:03.000Z" })}\n`);
    writeFileSync(queries, `${JSON.stringify({ user_id: "user-a", session_id: "session-a", turn_id: "turn-a", query: prompt })}\n`);
    process.env.SKILL_GATEWAY_EVENTS = events;
    process.env.SKILL_GATEWAY_LOG = queries;
    process.env.SKILL_GATEWAY_FEEDBACK = feedback;
    const server = createServer();
    const client = new Client({ name: "usage-feedback-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "usage_feedback_search_turns"));
      assert.ok(listed.tools.some((tool) => tool.name === "usage_feedback_update_turn"));

      const found = await client.callTool({ name: "usage_feedback_search_turns", arguments: { query: "invoice" } });
      assert.notEqual(found.isError, true);
      const results = (found.structuredContent as { results: Array<Record<string, unknown>> }).results;
      assert.equal(results.length, 1);
      assert.equal(results[0]?.turn_id, "turn-a");
      assert.equal(JSON.stringify(results).includes(prompt), false);

      const updated = await client.callTool({
        name: "usage_feedback_update_turn",
        arguments: {
          user_id: "user-a",
          session_id: "session-a",
          turn_id: "turn-a",
          user_skill_feedback: [
            { skill_name: "calendar", relevance: "relevant" },
            { skill_name: "invoice-review", relevance: "not_relevant" },
          ],
          comment: "Calendar was relevant to the request.",
          comment_source: "assistant_paraphrase",
        },
      });
      assert.notEqual(updated.isError, true);
      assert.equal(statSync(feedback).mode & 0o777, 0o600);
      const stored = JSON.parse(readFileSync(feedback, "utf8"));
      assert.equal(stored.schema_version, 4);
      assert.deepEqual(stored.user_skill_feedback, [
        { skill_name: "calendar", relevance: "relevant" },
        { skill_name: "invoice-review", relevance: "not_relevant" },
      ]);
      assert.deepEqual(stored.should_not_inject_skill_names, []);
      assert.equal(JSON.stringify(updated.structuredContent).includes("Calendar was relevant"), false);
    } finally {
      await client.close();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
