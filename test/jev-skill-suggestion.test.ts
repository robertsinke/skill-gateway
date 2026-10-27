import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JevSkillSuggestion, JEV_UPSTREAM_DEFAULTS, type FileSkill } from "../src/jev-skill-suggestion.ts";
import { DEFAULT_MODEL, decide, readWide, readRerank, requestBody, wideQuestions, rerankQuestions, detailOf, shortlistOf } from "../src/vendor/jev-skill-suggestion/policy.ts";
import register from "../extensions/jev-skill-suggestion.ts";
import { handle } from "../src/prompt-hook.ts";

function fixture(count = 8) {
  const root = mkdtempSync(join(tmpdir(), "jev-original-"));
  const roster: FileSkill[] = [];
  for (let i = 0; i < count; i++) {
    const name = `skill-${i}`, dir = join(root, name); mkdirSync(dir);
    const filePath = join(dir, "SKILL.md");
    writeFileSync(filePath, `---\nname: ${name}\ndescription: review task ${i}\n---\nSTEP-${i}: ${"x".repeat(900)} PRIVATE_TAIL_${i}\n`);
    roster.push({ name, description: `review task ${i}`, filePath });
  }
  return { root, roster };
}
function wide(names = ["skill-7", "skill-6", "skill-5", "skill-4"], gate = true) {
  return { answers: { which: { choice: names[0], probabilities: Object.fromEntries(names.map((n, i) => [n, .8 / (i + 1)])) },
    "gate::acts_on_user_system": { noul: gate ? .9 : 0 }, "gate::would_follow_documented_procedure": { noul: gate ? .9 : 0 }, "gate::prose_suffices": { noul: gate ? .1 : 1 } }, usage: { input_tokens: 100 } };
}
function rerank(winner = "skill-6", fits: Record<string, number> = { "skill-7": .8, "skill-6": .4, "skill-5": .1 }) {
  return { answers: { which: { choice: winner, confidence: .9 }, ...Object.fromEntries(Object.entries(fits).map(([n, p]) => [`fits::${n}`, { noul: p }])) }, usage: { input_tokens: 100 } };
}
function network(first: unknown = wide(), second: unknown = rerank()) {
  const bodies: any[] = [], signals: AbortSignal[] = [];
  const fetcher = (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); bodies.push(body); signals.push(options!.signal!);
    return new Response(JSON.stringify(body.questions["gate::acts_on_user_system"] ? first : second));
  }) as typeof fetch;
  return { bodies, signals, fetcher };
}

// Requests and decisions are compared with the actual vendored implementation, not a reworded imitation.
describe("original Jev policy in Pi", () => {
  it("keeps the pinned upstream policy byte-for-byte unchanged", () => {
    const bytes = readFileSync(new URL("../src/vendor/jev-skill-suggestion/policy.ts", import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), "85b18ffaaf5eb43c41360f77ec525627605ad7cf1fdec081a8ab5d7ae954244c");
  });

  it("ranks the whole roster, sends only top-three 700-character excerpts, and loads one full body locally", async () => {
    const f = fixture(), net = network(), chooser = new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: net.fetcher });
    try {
      const answer = await chooser.suggest("review task", f.roster, f.root);
      assert.deepEqual(net.bodies[0], JSON.parse(requestBody("typesafe", "review task", wideQuestions("typesafe", f.roster), DEFAULT_MODEL.typesafe)));
      assert.equal(Object.keys(net.bodies[0].questions.which.criteria).length, 8);
      assert.ok(!JSON.stringify(net.bodies[0]).includes("STEP-"));
      const shortlist = shortlistOf(readWide(JSON.stringify(wide()))!, f.roster, 3);
      const candidates = shortlist.map((s) => ({ ...s, detail: detailOf(s, readFileSync(f.roster.find((r) => r.name === s.name)!.filePath, "utf8"), 700) }));
      assert.deepEqual(net.bodies[1], JSON.parse(requestBody("typesafe", "review task", rerankQuestions("typesafe", candidates), DEFAULT_MODEL.typesafe)));
      assert.deepEqual(Object.keys(net.bodies[1].questions.which.criteria), ["skill-7", "skill-6", "skill-5"]);
      assert.ok(!JSON.stringify(net.bodies[1]).includes("PRIVATE_TAIL"));
      assert.equal(answer.name, "skill-6"); assert.ok(answer.context.includes("PRIVATE_TAIL_6")); assert.equal(answer.inline, true);
      assert.ok(!answer.context.includes("Skill tool")); assert.ok(!answer.context.includes("PRIVATE_TAIL_7"));
      assert.equal(answer.requests.length, 2); assert.ok(net.signals.every((s) => s instanceof AbortSignal));
      assert.ok(answer.requests.every((r) => r.status === "ok" && r.input_tokens === 100));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("preserves upstream decisions, including its overall-fit check rather than imposing a new winner cutoff", async () => {
    const f = fixture();
    try {
      for (const second of [rerank(), rerank("skill-7", { "skill-7": .01, "skill-6": .9 }), rerank("skill-7", { "skill-7": .2, "skill-6": .1 }), rerank("foreign", { "skill-7": .9 })]) {
        const net = network(wide(), second), chooser = new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: net.fetcher });
        const answer = await chooser.suggest("review task", f.roster, f.root);
        const expected = decide(readWide(JSON.stringify(wide())), readRerank(JSON.stringify(second)), f.roster, JEV_UPSTREAM_DEFAULTS, true);
        assert.equal(answer.name, expected.name); assert.equal(answer.reason, expected.reason);
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("rejects at the three-question gate without making the second request", async () => {
    const f = fixture(), net = network(wide(undefined, false));
    try {
      const answer = await new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: net.fetcher }).suggest("explain", f.roster, f.root);
      assert.equal(answer.name, null); assert.equal(answer.wide!.gate, 0); assert.equal(net.bodies.length, 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("makes no calls without excerpt consent, credentials, candidates, or for explicit skills", async () => {
    const f = fixture(), net = network();
    try {
      for (const [allow, key, prompt, roster] of [[false, "fixture", "review", f.roster], [true, null, "review", f.roster], [true, "fixture", "review", []], [true, "fixture", "/skill:skill-7", f.roster], [true, "fixture", '<skill name="skill-7" location="/file">\nbody\n</skill>', f.roster]] as const) {
        const answer = await new JevSkillSuggestion({ allowSkillExcerpts: allow, apiKey: key, fetcher: net.fetcher }).suggest(prompt, roster, f.root);
        assert.equal(answer.context, ""); assert.equal(answer.requests.length, 0);
      }
      assert.equal(net.bodies.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("never injects a skill that disables model invocation", async () => {
    const f = fixture(), net = network();
    writeFileSync(f.roster[7]!.filePath, "---\ndisable-model-invocation: true\n---\nNEVER_SEND_THIS");
    try {
      const answer = await new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: net.fetcher }).suggest("review", f.roster, f.root);
      assert.ok(!JSON.stringify(net.bodies[1]).includes("NEVER_SEND_THIS"));
      assert.ok(!Object.keys(net.bodies[1].questions.which.criteria).includes("skill-7"));
      assert.equal(answer.name, "skill-6");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("honors Pi's known invocation restriction even when the file cannot be read", async () => {
    const f = fixture(), net = network(wide(), rerank("skill-7"));
    f.roster[7]!.disableModelInvocation = true; rmSync(f.roster[7]!.filePath);
    try {
      const answer = await new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: net.fetcher }).suggest("review", f.roster, f.root);
      assert.equal(answer.name, null); assert.ok(!Object.keys(net.bodies[1].questions.which.criteria).includes("skill-7"));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("uses descriptions when a body is missing; caches bodies and injects them only once until reset", async () => {
    const f = fixture(), net = network(), chooser = new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: net.fetcher });
    rmSync(f.roster[5]!.filePath);
    try {
      assert.equal((await chooser.suggest("review", f.roster, f.root)).inline, true);
      assert.equal(net.bodies[1].questions.which.criteria["skill-5"], "review task 5");
      writeFileSync(f.roster[6]!.filePath, "---\nname: skill-6\n---\nNEW_BODY");
      const again = await chooser.suggest("review", f.roster, f.root);
      assert.ok(again.context.includes("already loaded above")); assert.equal(again.inline, false);
      assert.ok(!JSON.stringify(net.bodies[3]).includes("NEW_BODY"));
      chooser.reset();
      const fresh = await chooser.suggest("review", f.roster, f.root);
      assert.equal(fresh.inline, true); assert.ok(fresh.context.includes("NEW_BODY"));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("does not fall back to the first winner or retry when reranking errors", async () => {
    const f = fixture(); let calls = 0;
    try {
      const fetcher = (async () => ++calls === 1 ? new Response(JSON.stringify(wide())) : new Response("down", { status: 503 })) as typeof fetch;
      const answer = await new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher }).suggest("review", f.roster, f.root);
      assert.equal(answer.name, null); assert.equal(answer.context, ""); assert.equal(calls, 2);
      assert.equal(answer.requests[1]!.reason, "http_503"); assert.ok(answer.requests[1]!.cost_usd! > 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("handles invalid JSON, null, missing answers, invalid probabilities and timeouts without suggestions", async () => {
    const f = fixture();
    try {
      for (const body of ["bad json", "null", "{}", '{"answers":{"which":{"choice":"skill-7"},"gate::prose_suffices":{"noul":1e999}}}']) {
        const answer = await new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: (async () => new Response(body)) as typeof fetch }).suggest("review", f.roster, f.root);
        assert.equal(answer.context, ""); assert.equal(answer.requests.length, 1); assert.equal(answer.requests[0]!.status, "error");
      }
      const timed = await new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: (async () => { throw new DOMException("timeout", "TimeoutError"); }) as typeof fetch }).suggest("review", f.roster, f.root);
      assert.equal(timed.requests[0]!.reason, "timeout"); assert.equal(timed.name, null);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("discards an in-flight answer after a session/branch reset", async () => {
    const f = fixture(); let resolve!: (response: Response) => void;
    try {
      const chooser = new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey: "fixture", fetcher: (() => new Promise<Response>((r) => { resolve = r; })) as typeof fetch });
      const pending = chooser.suggest("review", f.roster, f.root); chooser.reset(); resolve(new Response(JSON.stringify(wide())));
      const answer = await pending; assert.equal(answer.context, ""); assert.equal(answer.reason, "context_changed"); assert.equal(answer.requests.length, 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe("Pi integration", () => {
  it("is opt-in, hides only the skill section, logs the exact turn, and suppresses only this session's legacy chooser", async () => {
    const f = fixture(), events = join(f.root, "events.jsonl");
    const keys = ["SKILL_GATEWAY_ROOT", "SKILL_GATEWAY_LOG", "SKILL_GATEWAY_EVENTS", "SKILL_GATEWAY_PI_JEV_SESSION"];
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const net = network(); let enabled = false;
    const handlers = new Map<string, (...args: any[]) => any>();
    const pi = { registerFlag() {}, getFlag: () => enabled, on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) };
    const ctx = { cwd: f.root, getSystemPromptOptions: () => ({}), sessionManager: { getSessionId: () => "native-main" }, ui: { notify() {}, setStatus() {} } };
    const event = () => ({ messageType: "user", prompt: "review task", systemPromptOptions: { skills: [{ name: "native-skill", description: "native procedure", filePath: join(f.root, "missing.md") }], sections: { keep: "KEEP" } } });
    try {
      process.env.SKILL_GATEWAY_ROOT = f.root; process.env.SKILL_GATEWAY_LOG = "-"; process.env.SKILL_GATEWAY_EVENTS = events;
      register(pi as any, { apiKey: "fixture", fetcher: net.fetcher });
      handlers.get("session_start")!({}, ctx);
      const unchanged = event(); assert.equal(await handlers.get("before_agent_start")!(unchanged, ctx), undefined); assert.equal(unchanged.systemPromptOptions.skills.length, 1);
      enabled = true; handlers.get("session_start")!({}, ctx);
      const e = event(), result = await handlers.get("before_agent_start")!(e, ctx);
      assert.deepEqual(e.systemPromptOptions.skills, []); assert.deepEqual(e.systemPromptOptions.sections, { keep: "KEEP" });
      assert.ok(net.bodies[0].questions.which.criteria["native-skill"]); assert.equal(result.message.customType, "jev-skill-suggestion");
      const row = JSON.parse(readFileSync(events, "utf8").trim());
      assert.equal(row.turn_id, result.message.details.turn_id); assert.equal(row.turn_id_source, "pi_jev_extension");
      assert.deepEqual(row.injected_skill_names, ["skill-6"]); assert.equal(row.requests.length, 2);
      let oldCalls = 0;
      const oldGate = async () => { oldCalls++; return { status: "reject" as const, probability: 0, model: "fixture" }; };
      const base = { prompt: "review task", agent: "pi", session_id: "native-main" };
      assert.equal(JSON.parse(await handle(base, process.env, oldGate)).hookSpecificOutput.additionalContext, ""); assert.equal(oldCalls, 0);
      const oldEnv = { ...process.env, SKILL_GATEWAY_GATE_MODE: "on", SKILL_GATEWAY_EVENTS: "-" };
      await handle({ ...base, session_id: "child-session" }, oldEnv, oldGate); assert.equal(oldCalls, 1);
      await handle({ ...base, agent: "claude" }, oldEnv, oldGate); assert.equal(oldCalls, 2);
      const notification = { ...event(), messageType: "custom" }; await handlers.get("before_agent_start")!(notification, ctx); assert.equal(net.bodies.length, 2);
      handlers.get("session_shutdown")!(); assert.equal(process.env.SKILL_GATEWAY_PI_JEV_SESSION, before.SKILL_GATEWAY_PI_JEV_SESSION);
    } finally {
      for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
