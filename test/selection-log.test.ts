import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MODEL_PHASES, readLatestInjection, readSelectionEvents } from "../src/selection-log.ts";

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
  assert.equal(report.total, 5);
  assert.deepEqual(report.counts, { pass: 2, reject: 0, error: 0, no_candidates: 0 });
});

test("counts describe the returned decisions, not rows the view cannot show", () => {
  const events = [
    ...Array.from({ length: 3 }, () => ({ event_type: "gate_decision", gate_status: "reject", injected_skill_names: [], platform: "bb" })),
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["ce-debug"], platform: "bb" },
  ];
  const report = readSelectionEvents(ledger(events), 1);
  assert.deepEqual(report.counts, { pass: 1, reject: 0, error: 0, no_candidates: 0 });
  assert.equal(report.total, 4);
  assert.equal(report.truncated, true);
});

test("reads only the tail of a ledger past the window size", () => {
  const filler = { event_type: "gate_decision", gate_status: "reject", injected_skill_names: [], platform: "old", reason: "x".repeat(1024) };
  const path = ledger([
    ...Array.from({ length: 4500 }, () => filler),
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["ce-debug"], platform: "recent" },
  ]);
  const report = readSelectionEvents(path, 5);
  assert.equal(report.decisions[0]!.platform, "recent");
  assert.equal(report.truncated, true);
  assert.ok(report.decisions.length <= 5);
});

test("reads a writer's candidate count when names are not stored", () => {
  const path = ledger([{ event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["a"], candidate_count: 148 }]);
  assert.equal(readSelectionEvents(path).decisions[0]!.candidates, 148);
});

test("reads the Jev path's old 'ranking' phase as the gate call it was", () => {
  const path = ledger([
    {
      event_type: "gate_decision",
      gate_status: "error",
      reason: "no answer",
      requests: [{ phase: "ranking", status: "error", reason: "timeout", latency_ms: 805 }],
    },
  ]);
  assert.equal(readSelectionEvents(path).decisions[0]!.failure, "gate timeout");
});

test("finds the newest decision for one thread", () => {
  const path = ledger([
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["old"], thread_id: "t1" },
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["other"], thread_id: "t2" },
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["new"], thread_id: "t1" },
  ]);
  assert.deepEqual(readLatestInjection("t1", path)?.skill, "new");
  assert.equal(readLatestInjection("t2", path)?.skill, "other");
  assert.equal(readLatestInjection("missing", path), null);
  assert.equal(readLatestInjection("", path), null);
});

test("reports failed model calls as coverage, not as decision counts", () => {
  const path = ledger([
    { event_type: "gate_decision", gate_status: "error", reason: "no answer", requests: [{ phase: "gate", status: "error", reason: "timeout", latency_ms: 800 }] },
    { event_type: "gate_decision", gate_status: "error", reason: "no answer", requests: [{ phase: "gate", status: "error", reason: "timeout", latency_ms: 805 }] },
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["a"], requests: [{ phase: "gate", status: "ok", reason: null, latency_ms: 210 }, { phase: "rerank", status: "error", reason: "timeout", latency_ms: 2000 }] },
    { event_type: "gate_decision", gate_status: "reject", injected_skill_names: [] },
    { event_type: "gate_decision", gate_status: "error", reason: "no answer" },
  ]);
  const report = readSelectionEvents(path);
  assert.deepEqual(report.failures, [
    { reason: "gate timeout", count: 2 },
    { reason: "no answer", count: 1 },
    { reason: "rerank timeout", count: 1 },
  ]);
  assert.deepEqual(report.counts, { pass: 1, reject: 1, error: 3, no_candidates: 0 });
});

test("knows only gate and rerank as model phases", () => {
  assert.deepEqual([...MODEL_PHASES], ["gate", "rerank"]);
});

test("shows an unknown phase instead of renaming it to one of the known ones", () => {
  const path = ledger([
    {
      event_type: "gate_decision",
      gate_status: "error",
      reason: "no answer",
      requests: [{ phase: "retrieval", status: "error", reason: "timeout", latency_ms: 12 }],
    },
  ]);
  assert.equal(readSelectionEvents(path).decisions[0]!.failure, "retrieval timeout");
});

test("keeps the host thread so a view can report one conversation", () => {
  const path = ledger([
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["a"], thread_id: "thr_abc" },
    { event_type: "gate_decision", gate_status: "reject", injected_skill_names: [], session_id: "s1" },
  ]);
  const report = readSelectionEvents(path);
  assert.equal(report.decisions[0]!.thread, null);
  assert.equal(report.decisions[1]!.thread, "thr_abc");
});

test("names why a model call failed instead of only 'no answer'", () => {
  const path = ledger([
    {
      event_type: "gate_decision",
      gate_status: "error",
      reason: "no answer",
      requests: [
        { phase: "gate", status: "error", reason: "timeout", latency_ms: 805 },
      ],
    },
    { event_type: "gate_decision", gate_status: "pass", injected_skill_names: ["a"], requests: [{ phase: "gate", status: "ok", reason: null, latency_ms: 210 }] },
    { event_type: "gate_decision", gate_status: "error", reason: "no answer" },
  ]);
  const report = readSelectionEvents(path);
  assert.equal(report.decisions[0]!.failure, null);
  assert.equal(report.decisions[1]!.failure, null);
  assert.equal(report.decisions[2]!.failure, "gate timeout");
});
