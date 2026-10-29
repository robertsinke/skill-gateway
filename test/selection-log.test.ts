import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSelectionEvents } from "../src/selection-log.ts";

function ledger(lines: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "sg-selection-")), "usage-events.jsonl");
  writeFileSync(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);
  return path;
}

test("reads gate decisions newest first and hides unrelated events", () => {
  const path = ledger([
    { event_type: "skill_load", skill_name: "ce-debug" },
    { event_type: "gate_decision", gate_status: "reject", platform: "pi", injected_skill_names: [], candidate_names: ["a"], timestamp: "2026-10-01T10:00:00.000Z" },
    { event_type: "gate_decision", gate_status: "pass", platform: "bb", injected_skill_names: ["ce-debug"], candidate_names: ["a", "b"], reason: "rerank", probability: 0.71, latency_ms: 612, session_id: "s1", timestamp: "2026-10-01T10:00:05.000Z" },
  ]);
  const report = readSelectionEvents(path);
  assert.equal(report.decisions.length, 2);
  assert.equal(report.decisions[0]!.skill, "ce-debug");
  assert.equal(report.decisions[0]!.platform, "bb");
  assert.equal(report.decisions[0]!.candidates, 2);
  assert.deepEqual(report.counts, { pass: 1, reject: 1, error: 0, no_candidates: 0 });
  assert.equal(report.sessions, 1);
});

test("skips malformed lines instead of failing the view", () => {
  const path = ledger(["not json", "{\"event_type\":\"gate_decision\"}", { event_type: "gate_decision", gate_status: "error", platform: "bb", reason: "timeout" }]);
  const report = readSelectionEvents(path);
  assert.equal(report.decisions.length, 1);
  assert.equal(report.decisions[0]!.status, "error");
  assert.deepEqual(report.counts, { pass: 0, reject: 0, error: 1, no_candidates: 0 });
});

test("returns an empty report when the ledger is absent", () => {
  const report = readSelectionEvents(join(tmpdir(), "sg-missing-ledger", "usage-events.jsonl"));
  assert.deepEqual(report.decisions, []);
  assert.equal(report.sessions, 0);
});

test("honours the limit and flags truncation", () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["s"], platform: "bb" }));
  const report = readSelectionEvents(ledger(events), 2);
  assert.equal(report.decisions.length, 2);
  assert.equal(report.truncated, true);
});
