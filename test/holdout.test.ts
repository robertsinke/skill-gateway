import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { score } from "../src/holdout.ts";
import type { Document } from "../src/rank.ts";

const HOLDOUT = fileURLToPath(new URL("../src/holdout.ts", import.meta.url));

function doc(name: string, description: string): Document {
  return { name, description, path: `/lib/${name}` };
}

describe("holdout", () => {
  it("counts a rank-1 hit at both cutoffs", () => {
    const report = score(
      [doc("calendar", "schedule a meeting"), doc("inbox", "read mail threads")],
      [{ query: "schedule a meeting", skill: "calendar" }],
    );
    assert.equal(report.hits_at_10, 1);
    assert.equal(report.hits_at_20, 1);
    assert.equal(report.recall_at_10, 1);
    assert.equal(report.recall_at_20, 1);
    assert.deepEqual(report.drift, []);
  });

  it("misses cutoff 10 and hits cutoff 20 at rank 15", () => {
    const documents = Array.from({ length: 14 }, (_, index) => doc(`neighbor-${String(index).padStart(2, "0")}`, "zebra signal"));
    documents.push(doc("target", "zebra"));
    const report = score(documents, [{ query: "zebra signal", skill: "target" }]);
    assert.equal(report.hits_at_10, 0);
    assert.equal(report.hits_at_20, 1);
    assert.equal(report.recall_at_10, 0);
    assert.equal(report.recall_at_20, 1);
  });

  it("keeps a missing skill in the denominator as drift", () => {
    const report = score(
      [doc("calendar", "schedule a meeting")],
      [
        { query: "schedule a meeting", skill: "calendar" },
        { query: "look up widgets", skill: "not-a-real-skill" },
      ],
    );
    assert.equal(report.denominator, 2);
    assert.equal(report.hits_at_10, 1);
    assert.equal(report.recall_at_10, 0.5);
    assert.deepEqual(report.drift, [{ query: "look up widgets", skill: "not-a-real-skill" }]);
  });

  it("counts a pair with no skill apart from recall", () => {
    const documents = [doc("calendar", "schedule a meeting")];
    const empty = score(documents, [{ query: "purple zircon teapot", skill: null }]);
    assert.deepEqual(empty.false_includes, []);
    assert.equal(empty.denominator, 0);
    assert.equal(empty.recall_at_10, null);
    const mixed = score(documents, [
      { query: "schedule a meeting", skill: "calendar" },
      { query: "schedule a meeting", skill: null },
    ]);
    assert.equal(mixed.recall_at_10, 1);
    assert.deepEqual(mixed.false_includes, [{ query: "schedule a meeting" }]);
  });

  it("does not score a pair that is missing its query", () => {
    const root = mkdtempSync(join(tmpdir(), "holdout-"));
    mkdirSync(join(root, "calendar"));
    writeFileSync(join(root, "calendar", "SKILL.md"), "---\nname: calendar\ndescription: schedule a meeting\n---\n", "utf8");
    const holdoutPath = join(root, "holdout.json");
    writeFileSync(holdoutPath, JSON.stringify([{ skill: "calendar" }, { query: "schedule a meeting", skill: "calendar" }]), "utf8");
    const proc = spawnSync(process.execPath, ["--experimental-strip-types", HOLDOUT, "--root", root, "--holdout", holdoutPath], {
      encoding: "utf8",
    });
    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /missing its query/);
    assert.equal(proc.stdout.includes("recall_at_10"), false);
  });
});
