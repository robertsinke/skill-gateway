import assert from "node:assert/strict";
import test from "node:test";
import { resolveTarget, selectViaBb } from "../extensions/jev-skill-suggestion-bb.ts";

test("posts one message to the BB plugin and returns its selection", async () => {
  let seen: { url: string; body: unknown } | null = null;
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    seen = { url: String(input), body: JSON.parse(String(init?.body)) };
    return new Response(
      JSON.stringify({ ok: true, name: "flaky-test-fixer", context: "<skill_relevance/>", reason: "picked", latency_ms: 12, candidates: [] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const selection = await selectViaBb(
    { prompt: "stabilize the upload test", sessionId: "s1", cwd: "/tmp" },
    { serverUrl: "http://127.0.0.1:1", token: "t", fetcher },
  );

  assert.equal(selection.name, "flaky-test-fixer");
  assert.equal(selection.context, "<skill_relevance/>");
  assert.equal(seen!.url, "http://127.0.0.1:1/api/v1/plugins/skill-gateway/http/select");
  assert.deepEqual(seen!.body, { prompt: "stabilize the upload test", sessionId: "s1", cwd: "/tmp" });
});

test("names the BB thread so the panel can find this turn again", async () => {
  let seen: unknown = null;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    seen = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, name: null, context: "", reason: "no answer", latency_ms: 1, candidates: [] }), {
      status: 200,
    });
  }) as typeof fetch;

  await selectViaBb(
    { prompt: "x", sessionId: "s1", threadId: "thr_abc123" },
    { serverUrl: "http://bb", token: "t", fetcher },
  );

  assert.deepEqual(seen, { prompt: "x", sessionId: "s1", threadId: "thr_abc123" });
});

test("a rejected request is an error, not an empty selection", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ ok: false, error: "select_failed", message: "gateway missing" }), { status: 502 })) as typeof fetch;
  await assert.rejects(
    () => selectViaBb({ prompt: "x", sessionId: "s" }, { serverUrl: "http://bb", token: "t", fetcher }),
    /BB selection failed/,
  );
});

test("a missing token fails instead of calling BB unauthenticated", async () => {
  await assert.rejects(
    () => selectViaBb({ prompt: "x", sessionId: "s" }, { serverUrl: "http://bb", token: null }),
    /no token/,
  );
});

test("a missing server URL fails before any request", async () => {
  assert.equal(resolveTarget({ serverUrl: "", token: "t" }).url, "");
  await assert.rejects(
    () => selectViaBb({ prompt: "x", sessionId: "s" }, { serverUrl: "", token: "t" }),
    /BB_SERVER_URL is not set/,
  );
});

type Handler = (...args: any[]) => any;

function harness(options: { fetcher?: typeof fetch } = {}) {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerFlag() {},
    getFlag: () => true,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  const statuses: string[] = [];
  const ctx = {
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "sess-1" },
    ui: { setStatus: (_key: string, value: string) => statuses.push(value), notify() {} },
  };
  return { pi, handlers, ctx, statuses, options };
}

test("claims the session, clears the roster, and injects one selection", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ ok: true, name: "flaky-test-fixer", context: "<skill/>", reason: "picked", latency_ms: 5 }), {
      status: 200,
    })) as typeof fetch;
  const { pi, handlers, ctx } = harness();
  const register = (await import("../extensions/jev-skill-suggestion-bb.ts")).default;
  register(pi as any, { serverUrl: "http://bb", token: "t", fetcher });

  handlers.get("session_start")!({}, ctx);
  assert.equal(process.env.SKILL_GATEWAY_BB_SESSION, "sess-1");
  assert.equal(process.env.SKILL_GATEWAY_PI_JEV_SESSION, "sess-1");

  const event = { messageType: "user", prompt: "stabilize the upload test", systemPromptOptions: { skills: [{ name: "native" }] } };
  const output = await handlers.get("before_agent_start")!(event, ctx);
  assert.deepEqual(event.systemPromptOptions.skills, []);
  assert.equal(output.message.customType, "skill-gateway-bb");
  assert.equal(output.message.content, "<skill/>");

  handlers.get("session_shutdown")!();
  assert.equal(process.env.SKILL_GATEWAY_BB_SESSION, undefined);
});

test("does not run automatic selection when a BB skill mention already resolved", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { pi, handlers, ctx } = harness();
  const register = (await import("../extensions/jev-skill-suggestion-bb.ts")).default;
  register(pi as any, { serverUrl: "http://bb", token: "t", fetcher });

  const event = {
    messageType: "user",
    prompt: "Make a plan\n\n<!-- skill-gateway-selected-skill -->\nkw:plan\n\nUse the plan workflow.",
    systemPromptOptions: { skills: [{ name: "native" }] },
  };
  const output = await handlers.get("before_agent_start")!(event, ctx);
  assert.equal(output, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(event.systemPromptOptions.skills, []);
});

test("keeps the roster hidden when BB cannot answer", async () => {
  const fetcher = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const { pi, handlers, ctx } = harness();
  const register = (await import("../extensions/jev-skill-suggestion-bb.ts")).default;
  register(pi as any, { serverUrl: "http://bb", token: "t", fetcher });

  const event = { messageType: "user", prompt: "anything", systemPromptOptions: { skills: [{ name: "native" }] } };
  const output = await handlers.get("before_agent_start")!(event, ctx);
  assert.equal(output, undefined);
  assert.deepEqual(event.systemPromptOptions.skills, []);
});

test("the registry default decides whether BB selection is on", async () => {
  const { default: register } = await import("../extensions/jev-skill-suggestion-bb.ts");
  const seen: unknown[] = [];
  const pi = { registerFlag: (name: string, spec: unknown) => seen.push({ name, spec }), getFlag: () => false, on() {} };
  register(pi as any, { enabledByDefault: true });
  register(pi as any, {});
  const specs = seen as { name: string; spec: { default: boolean } }[];
  assert.equal(specs[0]!.spec.default, true);
  assert.equal(specs[1]!.spec.default, false);
});
