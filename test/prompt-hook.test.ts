import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MODEL_PHASES } from "../src/selection-log.ts";
import { handle } from "../src/prompt-hook.ts";

const HOOK = fileURLToPath(new URL("../src/prompt-hook.ts", import.meta.url));

function skill(root: string, directory: string, frontmatter: string): string {
  const folder = join(root, directory);
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), `---\n${frontmatter.trim()}\n---\n\n# Body\n`, "utf8");
  return realpathSync(folder);
}

function run(root: string, payload: unknown, env: NodeJS.ProcessEnv = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], {
    input: text,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILL_GATEWAY_ROOT: root,
      SKILL_GATEWAY_LOG: "-",
      SKILL_GATEWAY_EVENTS: "-",
      SKILL_GATEWAY_GATE_MODE: "off",
      ...env,
    },
  });
}

describe("prompt hook", () => {
  it("injects candidates only when the gate passes and logs suppressed candidates separately", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const logFile = join(root, "queries.jsonl");
    const eventsFile = join(root, "usage-events.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const env = { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_LOG: logFile, SKILL_GATEWAY_EVENTS: eventsFile };
    let seenPrompt = "";
    let seenCandidates: string[] = [];
    const gate = async (prompt: string, candidates: { name: string; description: string }[]) => {
      seenPrompt = prompt;
      seenCandidates = candidates.map((candidate) => candidate.name);
      return { status: "reject" as const, probability: 0.2, model: "jev-1.13.0" };
    };
    const output = JSON.parse(await handle({ prompt: "please schedule a meeting" }, env, gate));
    assert.equal(seenPrompt, "please schedule a meeting");
    assert.deepEqual(seenCandidates, ["calendar"]);
    assert.equal(output.systemMessage, "");
    assert.equal(output.hookSpecificOutput.additionalContext, "");
    const entry = JSON.parse(readFileSync(logFile, "utf8"));
    assert.deepEqual(entry.skills, []);
    assert.deepEqual(entry.gate, { status: "reject", model: "jev-1.13.0", probability: 0.2, candidates: ["calendar"] });
    const event = JSON.parse(readFileSync(eventsFile, "utf8"));
    assert.equal(event.event_type, "gate_decision");
    assert.equal(event.gate_status, "reject");
    assert.deepEqual(event.candidate_names, ["calendar"]);
    assert.deepEqual(event.injected_skill_names, []);
    assert.equal(event.session_id, "");
    assert.equal(JSON.stringify(event).includes("please schedule a meeting"), false);
  });

  it("captures turn identity, retrieval ranks, and Jev token usage without persisting the prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const logFile = join(root, "queries.jsonl");
    const eventsFile = join(root, "usage-events.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const output = JSON.parse(await handle({
      prompt: "please schedule a meeting",
      session_id: "session-9",
      turn_id: "pi-run-9",
      turn_id_source: "pi_hooks_use_bridge",
      agent: "pi",
    }, { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_LOG: logFile, SKILL_GATEWAY_EVENTS: eventsFile }, async () => ({
      status: "pass", probability: 0.9, model: "jev-1.13.0", request_attempted: true, input_tokens: 42, output_tokens: 1,
    })));
    assert.match(output.hookSpecificOutput.additionalContext, /calendar/);
    const event = JSON.parse(readFileSync(eventsFile, "utf8"));
    assert.equal(event.turn_id, "pi-run-9");
    assert.equal(event.turn_id_source, "pi_hooks_use_bridge");
    assert.equal(event.request_attempted, true);
    assert.equal(event.input_tokens, 42);
    assert.equal(event.input_tokens_source, "typesafe_usage");
    assert.equal(event.jev_list_cost_usd, 0.000001764);
    assert.equal(event.cost_basis, "reported_input_tokens");
    assert.equal(event.cost_rate_usd_per_million_input_tokens, 0.042);
    assert.equal(event.candidate_rankings[0].name, "calendar");
    assert.equal(typeof event.candidate_rankings[0].search_score, "number");
    assert.equal(JSON.stringify(event).includes("please schedule a meeting"), false);
    assert.equal(JSON.parse(readFileSync(logFile, "utf8")).turn_id, "pi-run-9");
  });

  it("fails closed when the gate errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const output = JSON.parse(await handle(
      { prompt: "please schedule a meeting" },
      { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_EVENTS: "-" },
      async () => ({ status: "error", probability: null, model: "jev-1.13.0", reason: "timeout" }),
    ));
    assert.equal(output.systemMessage, "");
    assert.equal(output.hookSpecificOutput.additionalContext, "");
  });

  it("records gate latency before the separately measured reranker", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T00:00:00Z") });
    const root = mkdtempSync(join(tmpdir(), "hook-latency-"));
    const eventsFile = join(root, "usage-events.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    await handle({ prompt: "schedule a meeting", session_id: "session-treatment", turn_id: "latency-turn" },
      { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsFile, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_RERANK_MODE: "experiment" },
      async () => { t.mock.timers.tick(7); return { status: "pass", probability: 0.9, model: "jev-1.13.0" }; },
      async () => { t.mock.timers.tick(2000); return { status: "ok", fits: [{ name: "calendar", probability: 0.9 }], selected: ["calendar"],
        request_attempted: true, estimated_input_tokens: 50, cost_usd: 0.0000021, latency_ms: 2000 }; });
    const events = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.find((row) => row.event_type === "gate_decision").latency_ms, 7);
    assert.equal(events.find((row) => row.event_type === "skill_rerank_experiment").latency_ms, 2000);
  });

  it("runs shadow reranking after a pass, logs its suggestion, and leaves injection unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "hook-"));
  const eventsFile = join(root, "usage-events.jsonl");
  skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
  skill(root, "inbox", "name: inbox\ndescription: read mail threads\n");
  let rerankCalls = 0;
  const output = JSON.parse(await handle(
    { prompt: "schedule a meeting and read mail", turn_id: "turn-shadow" },
    { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsFile, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_RERANK_MODE: "shadow" },
    async () => ({ status: "pass", probability: 0.9, model: "jev-1.13.0" }),
    async (_prompt, candidates) => {
      rerankCalls++;
      return { status: "ok", fits: candidates.map((c) => ({ name: c.name, probability: c.name === "calendar" ? 0.9 : 0.05 })), selected: ["calendar"], request_attempted: true, input_tokens: 60, estimated_input_tokens: 60, cost_usd: 0.00000252, latency_ms: 15 };
    },
  ));
  assert.equal(rerankCalls, 1);
  assert.match(output.hookSpecificOutput.additionalContext, /calendar/);
  assert.match(output.hookSpecificOutput.additionalContext, /inbox/);
  const events = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
  const shadow = events.find((event) => event.event_type === "skill_rerank_shadow");
  assert.equal(shadow.turn_id, "turn-shadow");
  assert.deepEqual(shadow.selected_names, ["calendar"]);
  assert.equal(shadow.input_tokens, 60);
  assert.equal(JSON.stringify(shadow).includes("schedule a meeting"), false);
});

it("randomizes by stable session and applies rerank only in treatment", async () => {
  const root = mkdtempSync(join(tmpdir(), "hook-"));
  const eventsFile = join(root, "usage-events.jsonl");
  skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
  skill(root, "inbox", "name: inbox\ndescription: read mail threads\n");
  let rerankCalls = 0;
  const gate = async () => ({ status: "pass" as const, probability: 0.9, model: "jev-1.13.0" });
  let seenPolicy: unknown;
  const rerank = async (_prompt: string, candidates: { name: string; description: string }[], options?: { judgment?: string; threshold?: number }) => {
    rerankCalls++; seenPolicy = options;
    return { status: "ok" as const, fits: candidates.map((c) => ({ name: c.name, probability: c.name === "calendar" ? 0.9 : 0.05 })), selected: ["calendar"], request_attempted: true, estimated_input_tokens: 50, cost_usd: 0.0000021, latency_ms: 10 };
  };
  const env = { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsFile, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_RERANK_MODE: "experiment" };
  const treatment = JSON.parse(await handle({ prompt: "schedule a meeting and read mail", session_id: "session-treatment", turn_id: "treatment-turn" }, env, gate, rerank));
  const control = JSON.parse(await handle({ prompt: "schedule a meeting and read mail", session_id: "treatment", turn_id: "control-turn" }, env, gate, rerank));
  assert.equal((treatment.hookSpecificOutput.additionalContext.match(/^- \d+\./gm) ?? []).length, 1);
  assert.equal((control.hookSpecificOutput.additionalContext.match(/^- \d+\./gm) ?? []).length, 2);
  assert.equal(rerankCalls, 1);
  const events = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
  const treatmentGate = events.find((event) => event.event_type === "gate_decision" && event.turn_id === "treatment-turn");
  const controlGate = events.find((event) => event.event_type === "gate_decision" && event.turn_id === "control-turn");
  assert.equal(treatmentGate.experiment_arm, "treatment");
  assert.deepEqual(seenPolicy, { judgment: "relevance-v2", threshold: 0.1 });
  assert.equal(treatmentGate.rerank_policy, "relevance-v2-at-0.1");
  assert.equal(treatmentGate.rerank_threshold, 0.1);
  assert.equal(controlGate.rerank_policy, "relevance-v2-at-0.1");
  assert.deepEqual(treatmentGate.rerank_selected_names, ["calendar"]);
  assert.equal(controlGate.experiment_arm, "control");
  assert.equal(controlGate.rerank_selected_names, null);
});

it("injects the shortlist when the gate passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const output = JSON.parse(await handle(
      { prompt: "please schedule the quarterly offsite", turn_id: "turn-1" },
      { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_EVENTS: "-" },
      async () => ({ status: "pass", probability: 0.9, model: "jev-1.13.0" }),
    ));
    assert.match(output.hookSpecificOutput.additionalContext, /calendar/);
    assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
  });

  it("injects a shortlist without copying the prompt into additional context", () => {
    const prompt = "please schedule the quarterly offsite";
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const folder = skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    skill(root, "inbox", "name: inbox\ndescription: read mail threads\n");
    const proc = run(root, { prompt });
    assert.equal(proc.status, 0, proc.stderr);
    const output = JSON.parse(proc.stdout);
    const context = output.hookSpecificOutput.additionalContext as string;
    assert.equal(context.includes(prompt), false);
    assert.match(context, /dist\/search\.js "<query>" --limit 10/);
    assert.match(context, /already loaded a listed skill, reuse it instead of reading it again/);
    assert.match(context, /has not been loaded earlier in this conversation/);
    assert.match(context, /calendar/);
    assert.match(context, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(context, /schedule a meeting/);
    assert.equal(context.includes("inbox"), false);
    assert.ok(output.systemMessage.startsWith(prompt));
    assert.ok(output.systemMessage.includes(context));
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  });

  it("injects the shortlist for Pi and leaves the system message empty", () => {
    const prompt = "please schedule the quarterly offsite";
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt, agent: "pi", transcript_path: "/tmp/.pi/agent/sessions/example.jsonl" });
    const output = JSON.parse(proc.stdout);
    const context = output.hookSpecificOutput.additionalContext as string;
    assert.equal(context.includes(prompt), false);
    assert.match(context, /calendar/);
    assert.equal(output.systemMessage, "");
  });

  it("uses the shortlist alone as the system message when a turn id is present", () => {
    const prompt = "please schedule the quarterly offsite";
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt, turn_id: "turn-1" });
    const output = JSON.parse(proc.stdout);
    assert.equal(output.systemMessage.includes(prompt), false);
    assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
    assert.match(output.systemMessage, /calendar/);
  });

  it("does not inject an empty shortlist when search has no hits", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt: "purple zircon teapot" });
    const output = JSON.parse(proc.stdout);
    assert.equal(output.systemMessage, "");
    assert.equal(output.hookSpecificOutput.additionalContext, "");
  });

  it("caps the shortlist at five by default", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    for (let index = 0; index < 25; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      skill(root, name, `name: ${name}\ndescription: alpha signal\n`);
    }
    const proc = run(root, { userPrompt: "alpha signal" });
    const context = JSON.parse(proc.stdout).hookSpecificOutput.additionalContext as string;
    assert.equal(context.split("\n- ").length - 1, 5);
  });

  it("fails open on malformed JSON and a missing library", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "hook-")), "missing");
    for (const proc of [run(missing, "{"), run(missing, { prompt: "schedule a meeting" })]) {
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.systemMessage, "");
      assert.equal(output.hookSpecificOutput.additionalContext, "");
    }
  });

  it("records the user and session and leaves helped empty", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const logFile = join(root, "queries.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt: "please schedule the quarterly offsite", session_id: "session-9" }, {
      SKILL_GATEWAY_LOG: logFile,
      SKILL_GATEWAY_USER: "robert",
    });
    assert.equal(proc.status, 0, proc.stderr);
    const entry = JSON.parse(readFileSync(logFile, "utf8"));
    assert.equal(entry.user_id, "robert");
    assert.equal(entry.session_id, "session-9");
    assert.equal(entry.query, "please schedule the quarterly offsite");
    assert.deepEqual(entry.ranks[0], { rank: 1, name: "calendar" });
    assert.ok(entry.skills.includes("calendar"));
    assert.equal(entry.selected, null);
    assert.equal(entry.completed, null);
    assert.equal(entry.followup, null);
    assert.equal(entry.helped, null);
    assert.ok(entry.date);
  });

  it("marks the previous search with the next message in the session", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const logFile = join(root, "queries.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const env = { SKILL_GATEWAY_LOG: logFile };
    for (const payload of [
      { prompt: "please schedule the quarterly offsite", session_id: "session-9" },
      { prompt: "thanks, that works", session_id: "session-9" },
    ]) {
      const proc = run(root, payload, env);
      assert.equal(proc.status, 0, proc.stderr);
    }
    const rows = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows[0].followup, "thanks, that works");
    assert.equal(rows[0].reaction, "positive");
    assert.equal(rows[1].followup, null);
  });

  it("fails open when the prompt is not a string", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const proc = run(root, { prompt: ["not-a-string"] });
    const output = JSON.parse(proc.stdout);
    assert.equal(output.systemMessage, "");
    assert.equal(output.hookSpecificOutput.additionalContext, "");
  });

  it("records a failed gate call with its own phase and latency", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-attempt-"));
    const eventsFile = join(root, "usage-events.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    await handle(
      { prompt: "please schedule a meeting", session_id: "s1" },
      { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsFile, SKILL_GATEWAY_LOG: "-" },
      async () => ({ status: "error", probability: null, model: "jev-1.13.0", reason: "timeout", request_attempted: true }),
    );
    const event = JSON.parse(readFileSync(eventsFile, "utf8"));
    assert.equal(event.requests.length, 1);
    assert.equal(event.requests[0].phase, "gate");
    assert.equal(event.requests[0].status, "error");
    assert.equal(event.requests[0].reason, "timeout");
    assert.equal(typeof event.requests[0].latency_ms, "number");
  });

  it("only writes model phases the ledger vocabulary knows", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-phase-"));
    const eventsFile = join(root, "usage-events.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    await handle(
      { prompt: "please schedule a meeting", session_id: "s1" },
      { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsFile, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_RERANK_MODE: "shadow" },
      async () => ({ status: "pass", probability: 0.9, model: "jev-1.13.0", request_attempted: true }),
      async () => ({ status: "ok", fits: [{ name: "calendar", probability: 0.9 }], selected: ["calendar"], request_attempted: true, estimated_input_tokens: 1, cost_usd: 0, latency_ms: 1 }),
    );
    const row = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event_type === "gate_decision");
    const phases: string[] = row.requests.map((attempt: { phase: string }) => attempt.phase);
    assert.ok(phases.length > 1);
    for (const phase of phases) assert.ok((MODEL_PHASES as readonly string[]).includes(phase), `unknown phase ${phase}`);
  });

  it("records the rerank call alongside the gate it followed", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-attempt-"));
    const eventsFile = join(root, "usage-events.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    await handle(
      { prompt: "please schedule a meeting", session_id: "s1" },
      { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsFile, SKILL_GATEWAY_LOG: "-", SKILL_GATEWAY_RERANK_MODE: "shadow" },
      async () => ({ status: "pass", probability: 0.9, model: "jev-1.13.0", request_attempted: true }),
      async () => ({ status: "error", reason: "timeout", fits: [], selected: [], request_attempted: true, estimated_input_tokens: 0, cost_usd: null, latency_ms: 2000 }),
    );
    const event = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse).find((row) => row.event_type === "gate_decision");
    assert.deepEqual(event.requests.map((row: { phase: string; status: string; reason: string | null }) => [row.phase, row.status, row.reason]), [
      ["gate", "ok", null],
      ["rerank", "error", "timeout"],
    ]);
  });
});
