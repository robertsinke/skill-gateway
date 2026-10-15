import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extension, { applyBackslashCompletion, fixedHeightAutocompleteItems } from "../extensions/skill-gateway.ts";
import { skillReadPrompt } from "../src/picker-contract.ts";
import { promptDigest } from "../src/usage-events.ts";

describe("Pi skill picker extension", () => {
  it("registers live backslash autocomplete and input dispatch", () => {
    const events: string[] = [];
    const servers: string[] = [];
    const commands: string[] = [];
    extension({
      registerMcpServer(name: string) { servers.push(name); },
      registerCommand(name: string) { commands.push(name); },
      on(event: string) { events.push(event); },
    } as never);
    assert.ok(events.includes("before_agent_start"));
    assert.ok(events.includes("agent_start"));
    assert.ok(events.includes("turn_end"));
    assert.ok(commands.includes("skill-gate"));
    assert.ok(commands.includes("skill-feedback"));

    assert.deepEqual(servers, ["skill_gateway"]);
    assert.deepEqual(events.sort(), ["agent_start", "before_agent_start", "input", "session_start", "turn_end"]);
  });

  it("adds one space after a selected skill and preserves existing suffix text", () => {
    const selected = applyBackslashCompletion(["\\arc"], 0, 4, { value: "\\archify" }, "\\arc");
    assert.deepEqual(selected, { lines: ["\\archify "], cursorLine: 0, cursorCol: 9 });

    const existingSpace = applyBackslashCompletion(["\\arc more"], 0, 4, { value: "\\archify" }, "\\arc");
    assert.deepEqual(existingSpace, { lines: ["\\archify more"], cursorLine: 0, cursorCol: 9 });

    const adjacentSuffix = applyBackslashCompletion(["\\arcmore"], 0, 4, { value: "\\archify" }, "\\arc");
    assert.deepEqual(adjacentSuffix, { lines: ["\\archify more"], cursorLine: 0, cursorCol: 9 });
  });

  it("keeps the autocomplete panel at a fixed item count", () => {
    const oneMatch = fixedHeightAutocompleteItems([{ value: "\\kw:confidence", label: "kw:confidence" }]);
    const noMatches = fixedHeightAutocompleteItems([]);
    assert.equal(oneMatch.length, 20);
    assert.equal(noMatches.length, 20);
    assert.equal(oneMatch[0]?.label, "kw:confidence");
    assert.equal(noMatches[0]?.label, "No matching skills");
    assert.ok(oneMatch.slice(1).every(({ value }) => value.startsWith("__skill_gateway_padding__")));
  });

  it("records per-injected-skill relevance separately from verified agent reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-feedback-widget-"));
    const keys = ["SKILL_GATEWAY_EVENTS", "SKILL_GATEWAY_LOG", "SKILL_GATEWAY_FEEDBACK"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const prompt = "A local test prompt";
    const eventsPath = join(directory, "events.jsonl");
    const queriesPath = join(directory, "queries.jsonl");
    const feedbackPath = join(directory, "feedback.jsonl");
    const gate = {
      event_type: "gate_decision", user_id: "user-a", session_id: "session-a", turn_id: "turn-a",
      prompt_sha256: promptDigest(prompt), candidate_names: ["calendar", "invoice-review"], injected_skill_names: ["calendar", "invoice-review"],
      gate_status: "pass", probability: 0.8, threshold: 0.5, timestamp: "2026-10-14T18:00:00.000Z",
    };
    const load = { event_type: "skill_load", user_id: "user-a", session_id: "session-a", turn_id: "turn-a", skill_name: "calendar", timestamp: "2026-10-14T18:00:03.000Z" };
    writeFileSync(eventsPath, `${JSON.stringify(gate)}\n${JSON.stringify(load)}\n`);
    writeFileSync(queriesPath, `${JSON.stringify({ user_id: "user-a", session_id: "session-a", turn_id: "turn-a", query: prompt })}\n`);
    process.env.SKILL_GATEWAY_EVENTS = eventsPath;
    process.env.SKILL_GATEWAY_LOG = queriesPath;
    process.env.SKILL_GATEWAY_FEEDBACK = feedbackPath;
    try {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
      const widgets: ((tui: unknown, theme: unknown) => any)[] = [];
      extension({
        registerMcpServer() {},
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
        on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
      } as never);
      const selectionAnswers = ["Relevant", "Not relevant"];
      const ctx = {
        hasUI: true,
        mode: "tui",
        sessionManager: { getSessionId: () => "session-a" },
        ui: {
          setStatus() {},
          notify() {},
          async select() { return selectionAnswers.shift(); },
          async input() { return undefined; },
          setWidget(_key: string, content: unknown) { if (typeof content === "function") widgets.push(content as (tui: unknown, theme: unknown) => any); },
        },
      };
      handlers.get("before_agent_start")!({ prompt }, ctx);
      handlers.get("agent_start")!({}, ctx);
      handlers.get("turn_end")!({}, ctx);
      const component = widgets.at(-1)!( {}, {} );
      assert.match(component.render(120)[0]!, /\[Rate injected skills\]/);
      assert.match(component.render(120)[0]!, /agent read: calendar \(proxy\)/);
      await commands.get("skill-feedback")!.handler("", ctx);
      const stored = JSON.parse(readFileSync(feedbackPath, "utf8").trim());
      assert.equal(stored.schema_version, 4);
      assert.deepEqual(stored.user_skill_feedback, [
        { skill_name: "calendar", relevance: "relevant" },
        { skill_name: "invoice-review", relevance: "not_relevant" },
      ]);
      assert.equal(stored.legacy_shortlist_rating, null);
      assert.equal(stored.legacy_skill_need, null);
      assert.equal(stored.user_id, "user-a");
      assert.equal(stored.session_id, "session-a");
      assert.equal(stored.turn_id, "turn-a");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("builds an exact-name read instruction without embedding a path", () => {
    const prompt = skillReadPrompt("kw:plan");
    assert.match(prompt, /skills_read_skill/);
    assert.match(prompt, /"kw:plan"/);
    assert.doesNotMatch(prompt, /\/Users\/|\.local\/share/);
  });
});
