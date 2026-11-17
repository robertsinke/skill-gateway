import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { libraryRoster, selectFromStdin, selectSkill, suggestionRoster, type RosterSkill } from "../src/select.ts";
import { loadMerged } from "../src/search.ts";
import { MODEL_PHASES } from "../src/selection-log.ts";

function library(): RosterSkill[] {
  const root = mkdtempSync(join(tmpdir(), "sg-select-"));
  const make = (name: string, description: string, body: string): RosterSkill => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
    return { name, description, filePath };
  };
  return [
    make("flaky-test-fixer", "Diagnose flaky tests and stabilize them", "# Fix flaky tests\nUse deterministic time."),
    make("postmortem-writer", "Write a postmortem after an incident", "# Postmortem\nTimeline first."),
  ];
}

/** Answers a wide question with one ranked skill and a rerank that picks it. */
function fetcherChoosing(name: string): typeof fetch {
  let calls = 0;
  return (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    const answers =
      calls === 1
        ? { which: { choice: name, confidence: 0.9, probabilities: { [name]: 0.9 } } }
        : { which: { choice: name, confidence: 0.8 }, [`fits::${name}`]: { noul: 0.9 } };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as typeof fetch;
}

function assertAdvisoryTag(context: string, name: string): void {
  assert.match(context, new RegExp(`Relevant to the current request: ${name}\\.`));
  assert.match(context, /Ignore this if it does not fit/);
  assert.doesNotMatch(context, /deterministic time/);
  assert.doesNotMatch(context, /instructions follow/);
  assert.doesNotMatch(context, /SKILL\.md/);
  assert.doesNotMatch(context, /already loaded/);
}

test("selects one skill and returns an ignorable name tag", async () => {
  const roster = library();
  const result = await selectSkill(
    { prompt: "our upload test keeps failing intermittently", roster, cwd: "/tmp" },
    { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer"), record: false },
  );
  assert.equal(result.name, "flaky-test-fixer");
  assert.equal(result.inline, false);
  assertAdvisoryTag(result.context, "flaky-test-fixer");
  assert.equal(result.candidates.length, 2);
});

test("a name already in loaded still returns the same tag", async () => {
  const roster = library();
  const result = await selectSkill(
    { prompt: "still flaky", roster, loaded: ["flaky-test-fixer"] },
    { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer"), record: false },
  );
  assert.equal(result.name, "flaky-test-fixer");
  assert.equal(result.inline, false);
  assertAdvisoryTag(result.context, "flaky-test-fixer");
});

test("a completed gate rejection says no skill in the roster", async () => {
  const roster = library();
  const rejecting = (async () =>
    new Response(
      JSON.stringify({
        answers: {
          which: { choice: "flaky-test-fixer", confidence: 0.1, probabilities: { "flaky-test-fixer": 0.1 } },
          "gate::acts_on_user_system": { noul: 0.1 },
          "gate::would_follow_documented_procedure": { noul: 0.1 },
          "gate::prose_suffices": { noul: 0.9 },
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const result = await selectSkill(
    { prompt: "what time is it", roster },
    { apiKey: "test-key", fetcher: rejecting, record: false },
  );
  assert.equal(result.name, null);
  assert.equal(result.inline, false);
  assert.equal(result.reason, "needs a skill 0.10 < 0.3");
  assert.match(result.context, /No skill in the roster appears relevant/);
  assert.doesNotMatch(result.context, /deterministic time/);
});

test("a completed fit rejection says no skill in the roster", async () => {
  const roster = library();
  let calls = 0;
  const rejecting = (async () => {
    calls += 1;
    const answers =
      calls === 1
        ? {
            which: { choice: "flaky-test-fixer", probabilities: { "flaky-test-fixer": 0.9 } },
            "gate::acts_on_user_system": { noul: 0.9 },
            "gate::would_follow_documented_procedure": { noul: 0.9 },
            "gate::prose_suffices": { noul: 0.1 },
          }
        : { which: { choice: "flaky-test-fixer", confidence: 0.2 }, "fits::flaky-test-fixer": { noul: 0.1 } };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as typeof fetch;
  const result = await selectSkill(
    { prompt: "what time is it", roster },
    { apiKey: "test-key", fetcher: rejecting, record: false },
  );
  assert.equal(result.name, null);
  assert.equal(result.inline, false);
  assert.equal(result.reason, "nothing fits, best 0.10 < 0.3");
  assert.match(result.context, /No skill in the roster appears relevant/);
});

test("selects nothing without a TypeSafe key", async () => {
  const roster = library();
  const result = await selectSkill({ prompt: "flaky test", roster }, { apiKey: null, fetcher: fetcherChoosing("flaky-test-fixer"), record: false });
  assert.equal(result.name, null);
  assert.equal(result.reason, "credential_unavailable");
  assert.equal(result.context, "");
});

test("a rerank that gives no answer adds no tag", async () => {
  const roster = library();
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          answers: {
            which: { choice: "flaky-test-fixer", probabilities: { "flaky-test-fixer": 0.9 } },
            "gate::acts_on_user_system": { noul: 0.9 },
            "gate::would_follow_documented_procedure": { noul: 0.9 },
            "gate::prose_suffices": { noul: 0.1 },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("down", { status: 503 });
  }) as typeof fetch;
  const result = await selectSkill(
    { prompt: "stabilize the upload test", roster },
    { apiKey: "test-key", fetcher, record: false },
  );
  assert.equal(result.name, null);
  assert.equal(result.context, "");
  assert.match(result.reason, /^rerank gave no answer/);
});

test("stdin entrypoint rejects a missing prompt", async () => {
  await assert.rejects(() => selectFromStdin("{}"), /prompt is required/);
  await assert.rejects(() => selectFromStdin("[]"), /expected a JSON object/);
});

test("records one ledger row per selection with the asking host", async () => {
  const roster = library();
  const path = join(mkdtempSync(join(tmpdir(), "sg-select-ledger-")), "usage-events.jsonl");
  process.env.SKILL_GATEWAY_EVENTS = path;
  try {
    const result = await selectSkill(
      { prompt: "stabilize the upload test", roster, platform: "bb", sessionId: "s1" },
      { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer") },
    );
    assert.equal(result.name, "flaky-test-fixer");
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_type, "gate_decision");
    assert.equal(rows[0]!.platform, "bb");
    assert.equal(rows[0]!.session_id, "s1");
    assert.equal(rows[0]!.gate_status, "pass");
    assert.equal(rows[0]!.injection_kind, "advisory_tag");
    assert.deepEqual(rows[0]!.injected_skill_names, ["flaky-test-fixer"]);
  } finally {
    delete process.env.SKILL_GATEWAY_EVENTS;
  }
});

test("a completed rejection records injection_kind none", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sg-select-reject-")), "usage-events.jsonl");
  process.env.SKILL_GATEWAY_EVENTS = path;
  const rejecting = (async () =>
    new Response(
      JSON.stringify({
        answers: {
          which: { choice: "flaky-test-fixer", probabilities: { "flaky-test-fixer": 0.1 } },
          "gate::acts_on_user_system": { noul: 0.1 },
          "gate::would_follow_documented_procedure": { noul: 0.1 },
          "gate::prose_suffices": { noul: 0.9 },
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const result = await selectSkill(
      { prompt: "what time is it", roster: library(), platform: "bb" },
      { apiKey: "test-key", fetcher: rejecting },
    );
    assert.equal(result.name, null);
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows[0]!.injection_kind, "none");
    assert.equal(rows[0]!.gate_status, "reject");
  } finally {
    delete process.env.SKILL_GATEWAY_EVENTS;
  }
});

test("records the thread the host showed, not just its session", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sg-select-thread-")), "usage-events.jsonl");
  process.env.SKILL_GATEWAY_EVENTS = path;
  try {
    await selectSkill(
      { prompt: "stabilize the upload test", roster: library(), platform: "bb", sessionId: "s1", threadId: "thr_abc123" },
      { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer") },
    );
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows[0]!.thread_id, "thr_abc123");
    assert.equal(rows[0]!.session_id, "s1");
  } finally {
    delete process.env.SKILL_GATEWAY_EVENTS;
  }
});

test("writes only model phases the ledger vocabulary knows", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sg-select-phases-")), "usage-events.jsonl");
  process.env.SKILL_GATEWAY_EVENTS = path;
  try {
    await selectSkill(
      { prompt: "stabilize the upload test", roster: library(), platform: "bb" },
      { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer") },
    );
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const requests = rows[0]!.requests as { phase: string }[];
    assert.ok(requests.length > 0);
    for (const attempt of requests) {
      assert.ok((MODEL_PHASES as readonly string[]).includes(attempt.phase), `unknown phase ${attempt.phase}`);
    }
  } finally {
    delete process.env.SKILL_GATEWAY_EVENTS;
  }
});

function writeSkill(root: string, name: string, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`);
  return filePath;
}

test("default selection names only the manager library", () => {
  const manager = mkdtempSync(join(tmpdir(), "sg-manager-"));
  const gateway = mkdtempSync(join(tmpdir(), "sg-gateway-"));
  const managerFile = writeSkill(manager, "skill-a", "MANAGER_A");
  writeSkill(gateway, "skill-b", "PRIVATE_B");
  const roster = suggestionRoster({ managerRoot: manager, gatewayRoot: gateway });
  assert.deepEqual(roster.map((skill) => skill.name), ["skill-a"]);
  assert.equal(realpathSync(roster[0]!.filePath), realpathSync(managerFile));
  assert.deepEqual(
    loadMerged([gateway, manager]).map((skill) => skill.document.name),
    ["skill-a", "skill-b"],
  );
});

test("the same name in both roots uses the manager copy once", () => {
  const manager = mkdtempSync(join(tmpdir(), "sg-manager-"));
  const gateway = mkdtempSync(join(tmpdir(), "sg-gateway-"));
  const managerFile = writeSkill(manager, "shared", "MANAGER_COPY");
  writeSkill(gateway, "shared", "PRIVATE_COPY");
  const roster = suggestionRoster({ managerRoot: manager, gatewayRoot: gateway });
  assert.equal(roster.length, 1);
  assert.equal(roster[0]!.name, "shared");
  assert.equal(realpathSync(roster[0]!.filePath), realpathSync(managerFile));
});

test("an explicit roster can still select a private-library skill", async () => {
  const gateway = mkdtempSync(join(tmpdir(), "sg-gateway-"));
  const filePath = writeSkill(gateway, "skill-b", "PRIVATE_B");
  const result = await selectSkill(
    { prompt: "use the private skill", roster: [{ name: "skill-b", description: "skill-b", filePath }] },
    { apiKey: "test-key", fetcher: fetcherChoosing("skill-b"), record: false },
  );
  assert.equal(result.name, "skill-b");
});

test("an explicit root still loads that root", () => {
  const gateway = mkdtempSync(join(tmpdir(), "sg-gateway-"));
  writeSkill(gateway, "skill-b", "PRIVATE_B");
  const roster = libraryRoster(gateway);
  assert.deepEqual(roster.map((skill) => skill.name), ["skill-b"]);
});

test("the trial roster keeps the manager skill and the host skill", () => {
  const manager = mkdtempSync(join(tmpdir(), "sg-manager-"));
  const gateway = mkdtempSync(join(tmpdir(), "sg-gateway-"));
  writeSkill(manager, "skill-a", "MANAGER_A");
  writeSkill(gateway, "skill-b", "PRIVATE_B");
  const roster = suggestionRoster({
    managerRoot: manager,
    gatewayRoot: gateway,
    native: [{ name: "skill-c", description: "host skill", filePath: join(gateway, "missing", "SKILL.md") }],
  });
  assert.deepEqual(roster.map((skill) => skill.name), ["skill-a", "skill-c"]);
});

test("records why a model call failed, not just that nothing was injected", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sg-select-failure-")), "usage-events.jsonl");
  process.env.SKILL_GATEWAY_EVENTS = path;
  const timingOut = (async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;
  try {
    const result = await selectSkill(
      { prompt: "stabilize the upload test", roster: library(), platform: "bb" },
      { apiKey: "test-key", fetcher: timingOut },
    );
    assert.equal(result.name, null);
    assert.equal(result.reason, "no answer");
    assert.equal(result.context, "");
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows[0]!.injection_kind, "none");
    const requests = rows[0]!.requests as { phase: string; status: string; reason: string }[];
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.phase, "gate");
    assert.equal(requests[0]!.status, "error");
    assert.equal(requests[0]!.reason, "timeout");
  } finally {
    delete process.env.SKILL_GATEWAY_EVENTS;
  }
});
