import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promptDigest } from "../src/usage-events.ts";

const previousEndpoint = process.env.SKILL_GATEWAY_MCP_URL;
process.env.SKILL_GATEWAY_MCP_URL = "http://127.0.0.1:1/mcp";
const { default: extension } = await import("../extensions/skill-gateway.ts");

describe("Pi inline skill picker failure", () => {
  it("passes an inline prompt through and registers it when the gateway is unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-picker-error-"));
    const eventsPath = join(directory, "events.jsonl");
    const queriesPath = join(directory, "queries.jsonl");
    const previousEvents = process.env.SKILL_GATEWAY_EVENTS;
    const previousLog = process.env.SKILL_GATEWAY_LOG;
    const previousUser = process.env.SKILL_GATEWAY_USER;
    process.env.SKILL_GATEWAY_EVENTS = eventsPath;
    process.env.SKILL_GATEWAY_LOG = queriesPath;
    process.env.SKILL_GATEWAY_USER = "user-picker-error";
    try {
      const handlers = new Map<string, (...args: any[]) => any>();
      extension({
        registerMcpServer() {},
        registerCommand() {},
        on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      } as never);
      const ctx = {
        hasUI: false,
        mode: "rpc",
        sessionManager: { getSessionId: () => "session-picker-error" },
      };
      const prompt = "Please use \\calendar for this task";
      const result = await handlers.get("input")!({ text: prompt, source: "interactive", streamingBehavior: "steer" }, ctx);
      assert.deepEqual(result, { action: "continue" });
      handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: prompt }] } }, ctx);
      const event = JSON.parse(readFileSync(eventsPath, "utf8").trim());
      const query = JSON.parse(readFileSync(queriesPath, "utf8").trim());
      assert.equal(event.gate_status, "not_evaluated");
      assert.equal(event.prompt_sha256, promptDigest(prompt));
      assert.equal(query.query, prompt);
      assert.equal(query.turn_id, event.turn_id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (previousEvents === undefined) delete process.env.SKILL_GATEWAY_EVENTS;
      else process.env.SKILL_GATEWAY_EVENTS = previousEvents;
      if (previousLog === undefined) delete process.env.SKILL_GATEWAY_LOG;
      else process.env.SKILL_GATEWAY_LOG = previousLog;
      if (previousUser === undefined) delete process.env.SKILL_GATEWAY_USER;
      else process.env.SKILL_GATEWAY_USER = previousUser;
      if (previousEndpoint === undefined) delete process.env.SKILL_GATEWAY_MCP_URL;
      else process.env.SKILL_GATEWAY_MCP_URL = previousEndpoint;
    }
  });
});
