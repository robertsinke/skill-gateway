import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extension from "../extensions/skill-gateway.ts";
import { searchSkillUsageTurns } from "../src/skill-usage-feedback.ts";
import { promptDigest } from "../src/usage-events.ts";

const envKeys = ["SKILL_GATEWAY_EVENTS", "SKILL_GATEWAY_LOG", "SKILL_GATEWAY_FEEDBACK", "SKILL_GATEWAY_ROOT", "SKILL_GATEWAY_USER"] as const;

describe("Pi queued prompt feedback", () => {
  it("registers a queued prompt as its own turn and links later skill reads to it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-queued-feedback-"));
    const root = join(directory, "library");
    const skillDirectory = join(root, "calendar");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: calendar\ndescription: Calendar skill\n---\n", "utf8");
    const eventsPath = join(directory, "events.jsonl");
    const queriesPath = join(directory, "queries.jsonl");
    const feedbackPath = join(directory, "feedback.jsonl");
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.SKILL_GATEWAY_EVENTS = eventsPath;
    process.env.SKILL_GATEWAY_LOG = queriesPath;
    process.env.SKILL_GATEWAY_FEEDBACK = feedbackPath;
    process.env.SKILL_GATEWAY_ROOT = root;
    process.env.SKILL_GATEWAY_USER = "user-a";
    try {
      const firstPrompt = "first run prompt";
      const firstGate = {
        event_type: "gate_decision", user_id: "user-a", session_id: "session-a", turn_id: "first-turn",
        prompt_sha256: promptDigest(firstPrompt), candidate_names: ["calendar"], injected_skill_names: [],
        gate_status: "reject", timestamp: "2026-10-14T18:00:00.000Z",
      };
      writeFileSync(eventsPath, `${JSON.stringify(firstGate)}\n`);
      writeFileSync(queriesPath, `${JSON.stringify({ user_id: "user-a", session_id: "session-a", turn_id: "first-turn", query: firstPrompt })}\n`);

      const handlers = new Map<string, (...args: any[]) => unknown>();
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
      const widgets: ((tui: unknown, theme: unknown) => any)[] = [];
      const statuses: string[] = [];
      extension({
        registerMcpServer() {},
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
        on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
      } as never);
      const ctx = {
        hasUI: true,
        mode: "tui",
        cwd: directory,
        sessionManager: { getSessionId: () => "session-a" },
        ui: {
          setStatus(_key: string, status?: string) { if (status) statuses.push(status); },
          notify() {},
          async select() { return "No"; },
          setWidget(_key: string, content: unknown) {
            if (typeof content === "function") widgets.push(content as (tui: unknown, theme: unknown) => any);
          },
        },
      };

      handlers.get("before_agent_start")!({ prompt: firstPrompt }, ctx);
      handlers.get("agent_start")!({}, ctx);
      assert.match(widgets.at(-1)!({}, {}).render(200)[0]!, /first run prompt|injected: none/);
      handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: firstPrompt }] } }, ctx);

      await handlers.get("input")!({ text: "queued follow-up", source: "interactive", streamingBehavior: "steer" }, ctx);
      assert.equal(handlers.has("message_start"), true, "the extension must observe delivery of queued user messages");
      handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: "queued follow-up" }] } }, ctx);
      assert.match(statuses.at(-1)!, /not evaluated/i);
      assert.match(widgets.at(-1)!({}, {}).render(200)[0]!, /injected: none/);

      handlers.get("tool_execution_start")!({ toolCallId: "read-1", toolName: "skill_gateway__skills_read_skill", args: { name: "calendar" } }, ctx);
      handlers.get("tool_execution_end")!({ toolCallId: "read-1", toolName: "skill_gateway__skills_read_skill", isError: false, result: {} }, ctx);

      const turns = searchSkillUsageTurns({ session_id: "session-a", limit: 10 }, process.env).results;
      const queued = turns.find((turn) => turn.query_present && turn.query_match_status === "matched_hash" && turn.gate_decisions.some((gate) => gate.status === "not_evaluated"));
      assert.ok(queued, "the queued prompt should be searchable as an explicitly unevaluated turn");
      assert.equal(queued?.query_present, true);
      assert.deepEqual(queued?.loaded_skill_names, ["calendar"]);
      await commands.get("skill-feedback")!.handler("", ctx);
      const saved = JSON.parse(readFileSync(feedbackPath, "utf8").trim());
      assert.equal(saved.turn_id, queued?.turn_id);
      assert.equal(saved.injection_decision, "no");

      const stalePrompt = "same text after dequeue";
      await handlers.get("input")!({ text: stalePrompt, source: "interactive", streamingBehavior: "steer" }, ctx);
      const realGate = {
        event_type: "gate_decision", user_id: "user-a", session_id: "session-a", turn_id: "real-gated-turn",
        prompt_sha256: promptDigest(stalePrompt), candidate_names: [], injected_skill_names: [],
        gate_status: "reject", timestamp: "2026-10-14T18:01:00.000Z",
      };
      writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${JSON.stringify(realGate)}\n`);
      writeFileSync(queriesPath, `${readFileSync(queriesPath, "utf8")}${JSON.stringify({ user_id: "user-a", session_id: "session-a", turn_id: "real-gated-turn", query: stalePrompt })}\n`);
      handlers.get("before_agent_start")!({ prompt: stalePrompt }, ctx);
      handlers.get("agent_start")!({}, ctx);
      const realGateStatus = statuses.at(-1);
      handlers.get("message_start")!({ message: { role: "user", content: [{ type: "text", text: stalePrompt }] } }, ctx);
      assert.equal(statuses.at(-1), realGateStatus, "the real gated turn must not be replaced by a stale queue mirror");
      const matchingEvents = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .filter((event) => event.event_type === "gate_decision" && event.prompt_sha256 === promptDigest(stalePrompt));
      assert.equal(matchingEvents.length, 1);
      assert.equal(matchingEvents[0]?.turn_id, "real-gated-turn");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("records verified skill reads against the exact active turn without a UI", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-headless-load-"));
    const root = join(directory, "library");
    const skillDirectory = join(root, "calendar");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: calendar\ndescription: Calendar skill\n---\n", "utf8");
    const eventsPath = join(directory, "events.jsonl");
    const queriesPath = join(directory, "queries.jsonl");
    const previous = Object.fromEntries(["SKILL_GATEWAY_EVENTS", "SKILL_GATEWAY_LOG", "SKILL_GATEWAY_ROOT", "SKILL_GATEWAY_USER"]
      .map((key) => [key, process.env[key]]));
    process.env.SKILL_GATEWAY_EVENTS = eventsPath;
    process.env.SKILL_GATEWAY_LOG = queriesPath;
    process.env.SKILL_GATEWAY_ROOT = root;
    process.env.SKILL_GATEWAY_USER = "user-headless";
    try {
      const prompt = "schedule a calendar event";
      writeFileSync(eventsPath, `${JSON.stringify({
        event_type: "gate_decision", user_id: "user-headless", session_id: "session-headless", turn_id: "headless-turn",
        prompt_sha256: promptDigest(prompt), candidate_names: ["calendar"], injected_skill_names: ["calendar"],
        gate_status: "pass", timestamp: "2026-10-14T18:02:00.000Z",
      })}\n`);
      writeFileSync(queriesPath, `${JSON.stringify({ user_id: "user-headless", session_id: "session-headless", turn_id: "headless-turn", query: prompt })}\n`);
      const handlers = new Map<string, (...args: any[]) => unknown>();
      extension({
        registerMcpServer() {},
        registerCommand() {},
        on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
      } as never);
      const ctx = { hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "session-headless" } };
      handlers.get("before_agent_start")!({ prompt }, ctx);
      handlers.get("agent_start")!({}, ctx);
      handlers.get("tool_execution_start")!({ toolCallId: "call-headless", toolName: "skills_read_skill", args: { name: "calendar" } }, ctx);
      handlers.get("tool_execution_end")!({ toolCallId: "call-headless", toolName: "skills_read_skill", isError: false }, ctx);
      const loads = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .filter((event) => event.event_type === "skill_load");
      assert.equal(loads.length, 1);
      assert.equal(loads[0]?.turn_id, "headless-turn");
      assert.equal(loads[0]?.skill_name, "calendar");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
