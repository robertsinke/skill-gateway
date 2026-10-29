import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectFromStdin, selectSkill, type RosterSkill } from "../src/select.ts";

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

test("selects one skill and returns only its instructions", async () => {
  const roster = library();
  const result = await selectSkill(
    { prompt: "our upload test keeps failing intermittently", roster, cwd: "/tmp" },
    { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer"), record: false },
  );
  assert.equal(result.name, "flaky-test-fixer");
  assert.match(result.context, /<skill name="flaky-test-fixer"/);
  assert.match(result.context, /deterministic time/);
  assert.equal(result.candidates.length, 2);
});

test("an already injected skill is referenced, not inlined twice", async () => {
  const roster = library();
  const result = await selectSkill(
    { prompt: "still flaky", roster, loaded: ["flaky-test-fixer"] },
    { apiKey: "test-key", fetcher: fetcherChoosing("flaky-test-fixer"), record: false },
  );
  assert.equal(result.name, "flaky-test-fixer");
  assert.match(result.context, /already loaded above/);
  assert.doesNotMatch(result.context, /deterministic time/);
});

test("selects nothing when Jev rejects the prompt", async () => {
  const roster = library();
  const rejecting = (async () =>
    new Response(JSON.stringify({ answers: { which: { choice: "none", confidence: 0.2 } } }), { status: 200 })) as typeof fetch;
  const result = await selectSkill(
    { prompt: "what time is it", roster },
    { apiKey: "test-key", fetcher: rejecting, record: false },
  );
  assert.equal(result.name, null);
  assert.equal(result.context, "");
});

test("selects nothing without a TypeSafe key", async () => {
  const roster = library();
  const result = await selectSkill({ prompt: "flaky test", roster }, { apiKey: null, fetcher: fetcherChoosing("flaky-test-fixer"), record: false });
  assert.equal(result.name, null);
  assert.equal(result.reason, "credential_unavailable");
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
    assert.deepEqual(rows[0]!.injected_skill_names, ["flaky-test-fixer"]);
  } finally {
    delete process.env.SKILL_GATEWAY_EVENTS;
  }
});
